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
const NOTIFICATION_COOLDOWN_MS = Math.max(60_000, Number(process.env.NOTIFICATION_COOLDOWN_MS) || 15 * 60 * 1000);
const TOP_STOCK_COUNT = 10;
const TOP_STOCK_REFRESH_MS = 24 * 60 * 60 * 1000;
let trackedSymbols = [...DEFAULT_SYMBOLS];
let manualSymbols = [];
let dailyTopStocks = {
  date: null,
  symbols: [...DEFAULT_SYMBOLS],
  source: "Default watchlist",
  updatedAt: null,
  error: null
};
let db;
const averageVolumeCache = new Map();
const symbolSearchCache = new Map();
const newsCache = new Map();
const notificationCooldowns = new Map();
const recentNotifications = [];
let whatsappGroupCache = [];

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
        crossed_back_below_70 INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run("ALTER TABLE market_snapshots ADD COLUMN crossed_back_below_70 INTEGER NOT NULL DEFAULT 0", (error) => {
      if (error && !/duplicate column/i.test(error.message)) {
        console.error("Failed to add sell crossover column:", error.message);
      }
    });
    db.run("CREATE INDEX IF NOT EXISTS idx_market_snapshots_symbol_observed ON market_snapshots(symbol, observed_at)");
    db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `, () => {
      refreshWhatsAppGroupCache();
    });
  });
}

function normalizeSymbols(input) {
  const rawSymbols = Array.isArray(input) ? input : String(input || "").split(",");
  return rawSymbols
    .map((value) => value.trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(symbol))
    .filter((symbol, index, array) => array.indexOf(symbol) === index);
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function marketDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function syncTrackedSymbols() {
  trackedSymbols = Array.from(new Set([
    ...(dailyTopStocks.symbols.length ? dailyTopStocks.symbols : DEFAULT_SYMBOLS),
    ...manualSymbols
  ])).slice(0, MAX_SYMBOLS);
  return trackedSymbols;
}

function normalizeTopStockQuotes(quotes) {
  return normalizeSymbols((quotes || [])
    .filter((quote) => !quote.quoteType || ["EQUITY", "ETF"].includes(quote.quoteType))
    .map((quote) => quote.symbol))
    .slice(0, TOP_STOCK_COUNT);
}

async function refreshDailyTopStocks(force = false) {
  const today = marketDateKey();
  if (!force && dailyTopStocks.date === today && dailyTopStocks.symbols.length) {
    syncTrackedSymbols();
    return dailyTopStocks;
  }

  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=${TOP_STOCK_COUNT}`;
  try {
    const json = await requestJson(url);
    const result = json.finance && Array.isArray(json.finance.result) ? json.finance.result[0] : null;
    const symbols = normalizeTopStockQuotes(result && result.quotes);
    if (!symbols.length) throw new Error("No top stocks returned");

    dailyTopStocks = {
      date: today,
      symbols,
      source: "Yahoo Finance most active",
      updatedAt: new Date().toISOString(),
      error: null
    };
  } catch (error) {
    dailyTopStocks = {
      ...dailyTopStocks,
      date: dailyTopStocks.date || today,
      symbols: dailyTopStocks.symbols.length ? dailyTopStocks.symbols : [...DEFAULT_SYMBOLS],
      updatedAt: dailyTopStocks.updatedAt || new Date().toISOString(),
      error: error.message
    };
    console.warn(`Daily top stocks unavailable: ${error.message}`);
  }

  syncTrackedSymbols();
  return dailyTopStocks;
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve([]);
      return;
    }
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows || []);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Database is not ready"));
      return;
    }
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

async function refreshWhatsAppGroupCache() {
  try {
    whatsappGroupCache = await dbAll(`
      SELECT id, name, webhook_url AS webhookUrl, enabled, created_at AS createdAt
      FROM whatsapp_groups
      WHERE enabled = 1
      ORDER BY name
    `);
  } catch (error) {
    console.warn(`Failed to load WhatsApp groups: ${error.message}`);
  }
  return whatsappGroupCache;
}

async function getWhatsAppGroups(includeDisabled = false) {
  const rows = await dbAll(`
    SELECT id, name, webhook_url AS webhookUrl, enabled, created_at AS createdAt
    FROM whatsapp_groups
    ${includeDisabled ? "" : "WHERE enabled = 1"}
    ORDER BY name
  `);
  if (!includeDisabled) whatsappGroupCache = rows;
  return rows;
}

async function addWhatsAppGroup(name, webhookUrl) {
  const normalizedName = String(name || "").trim().slice(0, 80);
  const normalizedUrl = String(webhookUrl || "").trim();
  if (!normalizedName) throw new Error("Group name is required");
  if (!normalizedUrl) throw new Error("Webhook URL is required");
  const parsed = new URL(normalizedUrl);
  if (parsed.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");

  await dbRun(
    "INSERT INTO whatsapp_groups (name, webhook_url, enabled) VALUES (?, ?, 1)",
    [normalizedName, normalizedUrl]
  );
  return getWhatsAppGroups(true);
}

async function disableWhatsAppGroup(id) {
  const groupId = Number(id);
  if (!Number.isInteger(groupId) || groupId < 1) throw new Error("Valid group id is required");
  await dbRun("UPDATE whatsapp_groups SET enabled = 0 WHERE id = ?", [groupId]);
  return getWhatsAppGroups(true);
}

function notificationChannels() {
  const channels = [];
  if (process.env.SENDGRID_API_KEY && process.env.NOTIFY_EMAIL_FROM && parseList(process.env.NOTIFY_EMAIL_TO).length) {
    channels.push("email");
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM && parseList(process.env.NOTIFY_SMS_TO).length) {
    channels.push("sms");
  }
  if (process.env.NOTIFICATION_WEBHOOK_URL) {
    channels.push("webhook");
  }
  if (whatsappGroupCache.length) {
    channels.push("whatsapp");
  }
  return channels;
}

function notificationStatus() {
  const channels = notificationChannels();
  return {
    enabled: process.env.NOTIFICATION_ENABLED !== "false" && channels.length > 0,
    channels,
    cooldownMs: NOTIFICATION_COOLDOWN_MS,
    emailConfigured: channels.includes("email"),
    smsConfigured: channels.includes("sms"),
    webhookConfigured: channels.includes("webhook"),
    whatsappConfigured: channels.includes("whatsapp"),
    whatsappGroupCount: whatsappGroupCache.length,
    recent: recentNotifications.slice(0, 20)
  };
}

function addTrackedSymbols(input) {
  const newSymbols = normalizeSymbols(input);
  if (!newSymbols.length) return trackedSymbols;
  manualSymbols = Array.from(new Set([...manualSymbols, ...newSymbols])).slice(0, MAX_SYMBOLS);
  return syncTrackedSymbols();
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
        crossed_back_below_70,
        error,
        observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        item.crossedBackBelow70 ? 1 : 0,
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
  const crossedBackBelow70 = previousRsi >= 70 && rsi < 70;
  const state = crossedBackAbove30
    ? "BUY SIGNAL"
    : crossedBackBelow70
      ? "SELL SIGNAL"
      : rsi < 30
        ? "OVERSOLD"
        : rsi > 70
          ? "EXTENDED"
          : "WATCH";

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
    crossedBackBelow70,
    state,
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

async function searchSymbols(query) {
  const normalizedQuery = String(query || "").trim();
  if (normalizedQuery.length < 2) return [];

  const cacheKey = normalizedQuery.toLowerCase();
  const cached = symbolSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < AVG_VOLUME_CACHE_MS) {
    return cached.data;
  }

  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(normalizedQuery)}&quotesCount=8&newsCount=0`;
  const json = await requestJson(url);
  const quotes = Array.isArray(json.quotes) ? json.quotes : [];
  const results = quotes
    .filter((quote) => quote.symbol && quote.shortname)
    .filter((quote) => !quote.quoteType || ["EQUITY", "ETF"].includes(quote.quoteType))
    .map((quote) => ({
      symbol: String(quote.symbol).toUpperCase(),
      name: quote.shortname || quote.longname || quote.symbol,
      exchange: quote.exchDisp || quote.exchange || "",
      type: quote.quoteType || ""
    }))
    .filter((item, index, array) => array.findIndex((match) => match.symbol === item.symbol) === index)
    .slice(0, 6);

  symbolSearchCache.set(cacheKey, {
    cachedAt: Date.now(),
    data: results
  });
  return results;
}

function normalizeNewsItem(item) {
  if (!item || !item.title || !item.link) return null;
  const publishedAt = Number.isFinite(item.providerPublishTime)
    ? new Date(item.providerPublishTime * 1000).toISOString()
    : null;
  const thumbnail = item.thumbnail &&
    Array.isArray(item.thumbnail.resolutions) &&
    item.thumbnail.resolutions[0] &&
    item.thumbnail.resolutions[0].url;

  return {
    title: item.title,
    publisher: item.publisher || "",
    link: item.link,
    publishedAt,
    summary: item.summary || "",
    thumbnail: thumbnail || "",
    relatedTickers: Array.isArray(item.relatedTickers) ? item.relatedTickers : []
  };
}

async function getNews(query, symbols, limit = 24) {
  const normalizedQuery = String(query || "").trim();
  const normalizedSymbols = normalizeSymbols(symbols);
  const terms = normalizedQuery
    ? [normalizedQuery]
    : normalizedSymbols.length
      ? normalizedSymbols.slice(0, 8)
      : ["stock market"];
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 24, 40));
  const cacheKey = `${terms.join("|").toLowerCase()}::${normalizedLimit}`;
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 60 * 1000) {
    return cached.data;
  }

  const settled = await Promise.allSettled(terms.map(async (term) => {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(term)}&quotesCount=0&newsCount=${Math.min(normalizedLimit, 20)}`;
    const json = await requestJson(url);
    return Array.isArray(json.news) ? json.news : [];
  }));

  const articles = settled
    .flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .map(normalizeNewsItem)
    .filter(Boolean)
    .filter((item, index, array) => array.findIndex((match) => match.link === item.link) === index)
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, normalizedLimit);

  const data = {
    query: normalizedQuery,
    symbols: normalizedSymbols,
    updatedAt: new Date().toISOString(),
    articles
  };
  newsCache.set(cacheKey, {
    cachedAt: Date.now(),
    data
  });
  return data;
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

function requestBody(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "http:" ? http : https;
    const request = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || "POST",
        headers: {
          "Content-Length": Buffer.byteLength(body),
          ...options.headers
        }
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`${options.label || "Notification"} request failed with ${response.statusCode}: ${responseBody.slice(0, 240)}`));
            return;
          }
          resolve(responseBody);
        });
      }
    );

    request.setTimeout(8000, () => {
      request.destroy(new Error(`${options.label || "Notification"} request timed out`));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function requestJsonPost(url, headers, payload, label) {
  return requestBody(url, {
    label,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  }, JSON.stringify(payload));
}

function buildCrossoverAlert(item, observedAt) {
  const side = item.state === "SELL SIGNAL" ? "SELL" : "BUY";
  const direction = side === "BUY" ? "crossed above 30" : "crossed below 70";
  const subject = `${side} RSI crossover: ${item.symbol}`;
  const message = [
    `${subject}`,
    `${item.symbol} RSI ${direction}.`,
    `RSI: ${Number.isFinite(item.rsi) ? item.rsi.toFixed(2) : "--"} (previous ${Number.isFinite(item.previousRsi) ? item.previousRsi.toFixed(2) : "--"})`,
    `Price: ${Number.isFinite(item.price) ? `$${item.price.toFixed(2)}` : "--"}`,
    `Change today: ${Number.isFinite(item.todayChangePercent) ? `${item.todayChangePercent.toFixed(2)}%` : "--"}`,
    `Time: ${observedAt}`
  ].join("\n");

  return {
    symbol: item.symbol,
    side,
    state: item.state,
    subject,
    message,
    observedAt,
    rsi: item.rsi,
    previousRsi: item.previousRsi,
    price: item.price,
    todayChangePercent: item.todayChangePercent
  };
}

function rememberNotification(entry) {
  recentNotifications.unshift({
    ...entry,
    createdAt: new Date().toISOString()
  });
  recentNotifications.splice(25);
}

function shouldSendCrossoverAlert(item) {
  if (!item || !["BUY SIGNAL", "SELL SIGNAL"].includes(item.state)) return false;
  const key = `${item.symbol}:${item.state}`;
  const lastSentAt = notificationCooldowns.get(key) || 0;
  if (Date.now() - lastSentAt < NOTIFICATION_COOLDOWN_MS) return false;
  notificationCooldowns.set(key, Date.now());
  return true;
}

async function sendEmailAlert(alert) {
  const to = parseList(process.env.NOTIFY_EMAIL_TO).map((email) => ({ email }));
  if (!process.env.SENDGRID_API_KEY || !process.env.NOTIFY_EMAIL_FROM || !to.length) return null;

  await requestJsonPost("https://api.sendgrid.com/v3/mail/send", {
    Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`
  }, {
    personalizations: [{ to }],
    from: { email: process.env.NOTIFY_EMAIL_FROM },
    subject: alert.subject,
    content: [
      { type: "text/plain", value: alert.message }
    ]
  }, "Email notification");
  return "email";
}

async function sendSmsAlert(alert) {
  const recipients = parseList(process.env.NOTIFY_SMS_TO);
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM || !recipients.length) return null;

  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID)}/Messages.json`;
  await Promise.all(recipients.map((recipient) => {
    const body = new URLSearchParams({
      From: process.env.TWILIO_FROM,
      To: recipient,
      Body: alert.message.slice(0, 1500)
    }).toString();
    return requestBody(url, {
      label: "SMS notification",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }, body);
  }));
  return "sms";
}

async function sendWebhookAlert(alert) {
  if (!process.env.NOTIFICATION_WEBHOOK_URL) return null;
  await requestJsonPost(process.env.NOTIFICATION_WEBHOOK_URL, {}, alert, "Webhook notification");
  return "webhook";
}

async function sendWhatsAppGroupAlerts(alert, groups) {
  if (!Array.isArray(groups) || !groups.length) return null;
  await Promise.all(groups.map((group) => requestJsonPost(group.webhookUrl, {}, {
    group: {
      id: group.id,
      name: group.name
    },
    text: alert.message,
    alert
  }, `WhatsApp group notification ${group.name}`)));
  return "whatsapp";
}

async function notifyCrossovers(data, observedAt) {
  const groups = await getWhatsAppGroups();
  const status = notificationStatus();
  if ((process.env.NOTIFICATION_ENABLED === "false" || !status.channels.length) || !Array.isArray(data)) return;

  const alerts = data
    .filter((item) => shouldSendCrossoverAlert(item))
    .map((item) => buildCrossoverAlert(item, observedAt));

  await Promise.all(alerts.map(async (alert) => {
    const settled = await Promise.allSettled([
      sendEmailAlert(alert),
      sendSmsAlert(alert),
      sendWebhookAlert(alert),
      sendWhatsAppGroupAlerts(alert, groups)
    ]);
    const sentChannels = settled
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);
    const errors = settled
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason.message);

    rememberNotification({
      symbol: alert.symbol,
      side: alert.side,
      state: alert.state,
      channels: sentChannels,
      error: errors.join("; ") || null
    });

    if (errors.length) {
      console.warn(`Notification failed for ${alert.symbol}: ${errors.join("; ")}`);
    }
  }));
}

async function getMarketData() {
  await refreshDailyTopStocks();
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

function sendError(res, statusCode, message) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
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
        reject(new Error("Request body is too large"));
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Request body must be valid JSON"));
      }
    });
  });
}

function isAdminRequest(req, parsedUrl) {
  if (!process.env.ADMIN_TOKEN) return true;
  const headerToken = req.headers["x-admin-token"];
  const queryToken = parsedUrl.searchParams.get("token");
  return headerToken === process.env.ADMIN_TOKEN || queryToken === process.env.ADMIN_TOKEN;
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
        notifyCrossovers(data, observedAt).catch((error) => {
          console.warn(`Notification module failed: ${error.message}`);
        });
        sendJson(res, {
          symbols: trackedSymbols,
          manualSymbols,
          topStocks: dailyTopStocks,
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

  if (parsedUrl.pathname === "/api/top-stocks") {
    (async () => {
      try {
        const force = parsedUrl.searchParams.get("refresh") === "1";
        sendJson(res, {
          topStocks: await refreshDailyTopStocks(force),
          symbols: trackedSymbols,
          manualSymbols
        });
      } catch (error) {
        sendError(res, 500, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/notifications") {
    refreshWhatsAppGroupCache().finally(() => {
      sendJson(res, notificationStatus());
    });
    return;
  }

  if (parsedUrl.pathname === "/api/admin/whatsapp-groups") {
    if (!isAdminRequest(req, parsedUrl)) {
      sendError(res, 401, "Admin token is required");
      return;
    }
    (async () => {
      try {
        if (req.method === "GET") {
          sendJson(res, {
            protected: Boolean(process.env.ADMIN_TOKEN),
            groups: await getWhatsAppGroups(true)
          });
          return;
        }
        if (req.method === "POST") {
          const payload = await readJsonBody(req);
          sendJson(res, {
            groups: await addWhatsAppGroup(payload.name, payload.webhookUrl)
          });
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname.startsWith("/api/admin/whatsapp-groups/")) {
    if (!isAdminRequest(req, parsedUrl)) {
      sendError(res, 401, "Admin token is required");
      return;
    }
    (async () => {
      try {
        if (req.method !== "DELETE") {
          sendError(res, 405, "Method not allowed");
          return;
        }
        const id = parsedUrl.pathname.split("/").pop();
        sendJson(res, {
          groups: await disableWhatsAppGroup(id)
        });
      } catch (error) {
        sendError(res, 400, error.message);
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

  if (parsedUrl.pathname === "/api/search-symbols") {
    (async () => {
      try {
        sendJson(res, {
          query: parsedUrl.searchParams.get("q") || "",
          results: await searchSymbols(parsedUrl.searchParams.get("q"))
        });
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/news") {
    (async () => {
      try {
        const requestedSymbols = parsedUrl.searchParams.has("symbols")
          ? parsedUrl.searchParams.get("symbols")
          : trackedSymbols.join(",");
        sendJson(res, await getNews(
          parsedUrl.searchParams.get("q"),
          requestedSymbols,
          parsedUrl.searchParams.get("limit")
        ));
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
syncTrackedSymbols();

server.listen(PORT, () => {
  console.log(`Market Dashboard running at http://localhost:${PORT}`);
  console.log(`Writing market snapshots to ${DB_PATH}`);
  refreshDailyTopStocks(true).catch((error) => {
    console.warn(`Initial daily top stock refresh failed: ${error.message}`);
  });
  setInterval(() => {
    refreshDailyTopStocks(true).catch((error) => {
      console.warn(`Scheduled daily top stock refresh failed: ${error.message}`);
    });
  }, TOP_STOCK_REFRESH_MS);
});
