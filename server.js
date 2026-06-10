const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const PORT = process.env.PORT || 4177;
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, "data", "market-watch.sqlite");
const DEFAULT_SYMBOLS = ["MU", "MRVL", "NVDA", "TSLA", "INTC", "SNDK", "AMD", "AVGO", "AAPL", "MSFT"];
const MAX_SYMBOLS = 50;
const MAX_POST_BYTES = 4096;
let trackedSymbols = [...DEFAULT_SYMBOLS];
let db;

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

async function getSymbolData(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const json = await requestJson(url);
  const result = json.chart && json.chart.result && json.chart.result[0];
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
  const currentVolume = volumes[volumes.length - 1];
  const averageVolume = volumes.length >= 14
    ? volumes.slice(-14).reduce((sum, value) => sum + value, 0) / 14
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
  const requested = req.url === "/" ? "/index.html" : req.url;
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
