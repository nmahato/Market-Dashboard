const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const PORT = process.env.PORT || 4178;
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, "data", "market-watch.sqlite");
const DEFAULT_SYMBOLS = ["MU", "MRVL", "NVDA", "TSLA", "INTC", "SNDK", "AMD", "AVGO", "AAPL", "MSFT"];
const MAX_SYMBOLS = 50;
const MAX_POST_BYTES = 4096;
const AVG_VOLUME_CACHE_MS = 30 * 60 * 1000;
const CANDLE_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m"]);
let trackedSymbols = [...DEFAULT_SYMBOLS];
let db;
const averageVolumeCache = new Map();

function initDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new sqlite3.Database(DB_PATH, (error) => {
    if (error) {
      console.error("Failed to open SQLite database:", error.message);
    }
  });

  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        price REAL,
        volume INTEGER,
        avg_volume INTEGER,
        today_change_percent REAL,
        rsi REAL,
        previous_rsi REAL,
        state TEXT NOT NULL,
        crossed_back_above_30 INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run("CREATE INDEX IF NOT EXISTS idx_market_snapshots_symbol_observed ON market_snapshots(symbol, observed_at)");
  });
}

function normalizeSymbols(input) {
  const rawSymbols = Array.isArray(input) ? input : String(input || "").split(",");
  return rawSymbols
    .map((value) => value.trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(symbol))
    .filter((symbol, index, array) => array.indexOf(symbol) === index);
}

function addTrackedSymbols(input) {
  const newSymbols = normalizeSymbols(input);
  if (!newSymbols.length) return trackedSymbols;
  trackedSymbols = Array.from(new Set([...trackedSymbols, ...newSymbols])).slice(0, MAX_SYMBOLS);
  return trackedSymbols;
}

function saveMarketSnapshot(data, observedAt) {
  if (!db || !Array.isArray(data) || !data.length) return;

  db.serialize(() => {
    const statement = db.prepare(`
      INSERT INTO market_snapshots (
        symbol,
        price,
        volume,
        avg_volume,
        today_change_percent,
        rsi,
        previous_rsi,
        state,
        crossed_back_above_30,
        error,
        observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    data.forEach((item) => {
      statement.run(
        item.symbol,
        Number.isFinite(item.price) ? item.price : null,
        Number.isFinite(item.volume) ? item.volume : null,
        Number.isFinite(item.avgVolume) ? item.avgVolume : null,
        Number.isFinite(item.todayChangePercent) ? item.todayChangePercent : null,
        Number.isFinite(item.rsi) ? item.rsi : null,
        Number.isFinite(item.previousRsi) ? item.previousRsi : null,
        item.state || "ERROR",
        item.crossedBackAbove30 ? 1 : 0,
        item.error || null,
        observedAt
      );
    });

    statement.finalize((error) => {
      if (error) {
        console.error("Failed to save market snapshot:", error.message);
      }
    });
  });
}

function calculateRsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss += -delta;
  }

  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function rsiSeries(closes, period = 14) {
  const values = [];
  for (let i = period; i < closes.length; i += 1) {
    values.push(calculateRsi(closes.slice(0, i + 1), period));
  }
  return values.filter((value) => Number.isFinite(value));
}

async function getAverageVolumeData(symbol) {
  const cached = averageVolumeCache.get(symbol);
  if (cached && Date.now() - cached.cachedAt < AVG_VOLUME_CACHE_MS) {
    return cached.data;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`;
  try {
    const json = await requestJson(url);
    const result = json.chart && json.chart.result && json.chart.result[0];
    const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
    const volumes = quote && Array.isArray(quote.volume)
      ? quote.volume.filter((value) => Number.isFinite(value) && value > 0)
      : [];

    if (!volumes.length) return {};

    const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const data = {
      averageDailyVolume10Day: average(volumes.slice(-10)),
      averageDailyVolume3Month: average(volumes)
    };
    averageVolumeCache.set(symbol, {
      cachedAt: Date.now(),
      data
    });
    return data;
  } catch (error) {
    console.warn(`Average volume unavailable for ${symbol}: ${error.message}`);
    return {};
  }
}

async function getSymbolData(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const [json, volumeData] = await Promise.all([
    requestJson(url),
    getAverageVolumeData(symbol)
  ]);
  const result = json.chart && json.chart.result && json.chart.result[0];
  const meta = (result && result.meta) || {};
  const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote || !Array.isArray(quote.close)) {
    throw new Error("No intraday candles returned");
  }

  const closes = quote.close.filter((value) => Number.isFinite(value));
  const opens = (quote.open || []).filter((value) => Number.isFinite(value));
  const volumes = (quote.volume || []).filter((value) => Number.isFinite(value));
  if (closes.length < 16) {
    throw new Error("Not enough candles for RSI");
  }

  const series = rsiSeries(closes);
  const last = closes[closes.length - 1];
  const startPrice = opens[0] || closes[0];
  const intradayVolume = volumes.reduce((sum, value) => sum + value, 0);
  const currentVolume = Number.isFinite(meta.regularMarketVolume)
    ? Math.max(meta.regularMarketVolume, intradayVolume)
    : intradayVolume;
  const averageVolume = Number.isFinite(volumeData.averageDailyVolume10Day)
    ? volumeData.averageDailyVolume10Day
    : Number.isFinite(volumeData.averageDailyVolume3Month)
      ? volumeData.averageDailyVolume3Month
      : Number.isFinite(meta.averageDailyVolume10Day)
        ? meta.averageDailyVolume10Day
        : Number.isFinite(meta.averageDailyVolume3Month)
          ? meta.averageDailyVolume3Month
          : null;
  const todayChangePercent = Number.isFinite(startPrice) && startPrice !== 0
    ? ((last - startPrice) / startPrice) * 100
    : null;
  const rsi = series[series.length - 1];
  const previousRsi = series[series.length - 2];
  const crossedBackAbove30 = previousRsi <= 30 && rsi > 30;

  return {
    symbol,
    price: Number(last.toFixed(2)),
    volume: Number.isFinite(currentVolume) ? Math.round(currentVolume) : null,
    avgVolume: Number.isFinite(averageVolume) ? Math.round(averageVolume) : null,
    todayChangePercent: Number.isFinite(todayChangePercent) ? Number(todayChangePercent.toFixed(2)) : null,
    chart: closes.slice(-20),
    rsi: Number(rsi.toFixed(2)),
    previousRsi: Number(previousRsi.toFixed(2)),
    crossedBackAbove30,
    state: crossedBackAbove30 ? "BUY SIGNAL" : rsi < 30 ? "OVERSOLD" : rsi > 70 ? "EXTENDED" : "WATCH",
    updatedAt: new Date().toISOString()
  };
}

async function getCandles(symbol, interval = "1m") {
  const normalizedSymbol = normalizeSymbols(symbol)[0];
  const normalizedInterval = CANDLE_INTERVALS.has(interval) ? interval : "1m";
  if (!normalizedSymbol) {
    throw new Error("A valid symbol is required");
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalizedSymbol)}?range=1d&interval=${normalizedInterval}`;
  const json = await requestJson(url);
  const result = json.chart && json.chart.result && json.chart.result[0];
  const timestamps = result && Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!quote || !timestamps.length) {
    throw new Error("No candles returned");
  }

  const candles = timestamps
    .map((timestamp, index) => ({
      time: new Date(timestamp * 1000).toISOString(),
      open: quote.open && quote.open[index],
      high: quote.high && quote.high[index],
      low: quote.low && quote.low[index],
      close: quote.close && quote.close[index],
      volume: quote.volume && quote.volume[index]
    }))
    .filter((candle) => Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.volume));

  if (!candles.length) {
    throw new Error("No complete candles returned");
  }

  return {
    symbol: normalizedSymbol,
    interval: normalizedInterval,
    updatedAt: new Date().toISOString(),
    candles
  };
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json"
        }
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Quote request failed with ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.setTimeout(8000, () => {
      request.destroy(new Error("Quote request timed out"));
    });

    request.on("error", reject);
  });
}

async function getMarketData() {
  const settled = await Promise.allSettled(trackedSymbols.map(getSymbolData));
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      symbol: trackedSymbols[index],
      error: result.reason.message,
      state: "ERROR",
      updatedAt: new Date().toISOString()
    };
  });
}

function sendJson(res, payload) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendStatic(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requested = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const filePath = path.join(__dirname, "public", path.normalize(requested).replace(/^(\.\.[/\\])+/, ""));
  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.url.startsWith("/api/market")) {
    (async () => {
      try {
        const data = await getMarketData();
        const observedAt = new Date().toISOString();
        saveMarketSnapshot(data, observedAt);
        sendJson(res, {
          symbols: trackedSymbols,
          updatedAt: observedAt,
          data
        });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/candles") {
    (async () => {
      try {
        const data = await getCandles(
          parsedUrl.searchParams.get("symbol") || DEFAULT_SYMBOLS[0],
          parsedUrl.searchParams.get("interval") || "1m"
        );
        sendJson(res, data);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    })();
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/symbols")) {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_POST_BYTES) {
        tooLarge = true;
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body is too large" }));
        return;
      }

      try {
        const payload = body ? JSON.parse(body) : {};
        const symbols = addTrackedSymbols(payload.symbols);
        sendJson(res, {
          symbols,
          updatedAt: new Date().toISOString()
        });
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    return;
  }

  sendStatic(req, res);
});

initDatabase();

server.listen(PORT, () => {
  console.log(`Market RSI dashboard running at http://localhost:${PORT}`);
  console.log(`Writing market snapshots to ${DB_PATH}`);
});
