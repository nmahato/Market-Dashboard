const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 4177;
const SYMBOLS = ["MU", "MRVL", "NVDA", "TSLA", "INTC", "SNDK", "AMD", "AVGO", "AAPL", "MSFT"];

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
  if (closes.length < 16) {
    throw new Error("Not enough candles for RSI");
  }

  const series = rsiSeries(closes);
  const last = closes[closes.length - 1];
  const rsi = series[series.length - 1];
  const previousRsi = series[series.length - 2];
  const crossedBackAbove30 = previousRsi <= 30 && rsi > 30;

  return {
    symbol,
    price: Number(last.toFixed(2)),
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
        rejectUnauthorized: false,
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
  const settled = await Promise.allSettled(SYMBOLS.map(getSymbolData));
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      symbol: SYMBOLS[index],
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

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/market")) {
    try {
      const data = await getMarketData();
      sendJson(res, {
        symbols: SYMBOLS,
        updatedAt: new Date().toISOString(),
        data
      });
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  sendStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Market RSI dashboard running at http://localhost:${PORT}`);
});
