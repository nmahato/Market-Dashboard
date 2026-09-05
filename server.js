require("./load-env");

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");

const PORT = process.env.PORT || 4180;
const SESSION_COOKIE_NAME = "session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_REGISTRATION_AGE = 18;
const USER_LIST_COLUMNS = `
  id, username, email, phone_number AS phoneNumber, full_name AS fullName, role, status,
  email_verified_at AS emailVerifiedAt, phone_verified_at AS phoneVerifiedAt,
  created_at AS createdAt
`;
const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
const EMAIL_OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, "data", "market-watch.sqlite");
const DEFAULT_SYMBOLS = ["MU", "MRVL", "NVDA", "TSLA", "INTC", "SNDK", "AMD", "AVGO", "AAPL", "MSFT"];
const MAX_SYMBOLS = 50;
const MAX_POST_BYTES = 4096;
const AVG_VOLUME_CACHE_MS = 30 * 60 * 1000;
const CANDLE_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m"]);
const NOTIFICATION_COOLDOWN_MS = Math.max(60_000, Number(process.env.NOTIFICATION_COOLDOWN_MS) || 15 * 60 * 1000);
const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
const ALPACA_BUY_NOTIONAL = Math.max(1, Math.min(Number(process.env.ALPACA_BUY_NOTIONAL) || 100, 1000));
const ALPACA_MAX_DAILY_ORDERS = Math.max(1, Math.min(Number(process.env.ALPACA_MAX_DAILY_ORDERS) || 3, 20));
const ALPACA_ALLOWED_SYMBOLS = new Set(normalizeSymbols(process.env.ALPACA_ALLOWED_SYMBOLS));
const TOP_STOCK_COUNT = 10;
const TOP_STOCK_REFRESH_MS = 24 * 60 * 60 * 1000;
const SCREENER_PRESETS = new Map([
  ["most-active", { label: "Most Active", scrId: "most_actives" }],
  ["top-gainers", { label: "Top Gainers", scrId: "day_gainers" }],
  ["top-losers", { label: "Top Losers", scrId: "day_losers" }]
]);
let trackedSymbols = [...DEFAULT_SYMBOLS];
let manualSymbols = [];
let selectedWatchSymbols = null;
let dailyTopStocks = {
  date: null,
  symbols: [...DEFAULT_SYMBOLS],
  source: "Default watchlist",
  updatedAt: null,
  error: null
};
let db;
const averageVolumeCache = new Map();
const quoteFundamentalsCache = new Map();
const QUOTE_FUNDAMENTALS_CACHE_MS = 10 * 60 * 1000;
const quoteProfileCache = new Map();
const QUOTE_PROFILE_CACHE_MS = 30 * 60 * 1000;
const symbolSearchCache = new Map();
const newsCache = new Map();
const notificationCooldowns = new Map();
const recentNotifications = [];
let whatsappGroupCache = [];
const tradingExecutionsInFlight = new Set();
let paperTradeBatchRunning = false;
const sessions = new Map();

async function migrateGlobalWishlistToAdmin() {
  const existing = await dbGet("SELECT COUNT(*) AS count FROM user_watchlist_symbols");
  if (existing && existing.count > 0) return;
  if (!manualSymbols.length) return;

  const admin = await dbGet("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
  if (!admin) return;

  for (const symbol of manualSymbols) {
    await dbRun(
      "INSERT OR IGNORE INTO user_watchlist_symbols (user_id, symbol) VALUES (?, ?)",
      [admin.id, symbol]
    );
  }
  console.log(`Migrated ${manualSymbols.length} global wishlist symbol(s) to admin user id ${admin.id}.`);
}

async function migrateSingleWishlistsToNamedLists() {
  const existing = await dbGet("SELECT COUNT(*) AS count FROM wishlists");
  if (existing && existing.count > 0) return;

  const userIds = await dbAll("SELECT DISTINCT user_id FROM user_watchlist_symbols");
  for (const row of userIds) {
    const symbols = await dbAll("SELECT symbol FROM user_watchlist_symbols WHERE user_id = ?", [row.user_id]);
    if (!symbols.length) continue;
    const inserted = await dbRun("INSERT INTO wishlists (user_id, name) VALUES (?, 'My Watchlist')", [row.user_id]);
    for (const { symbol } of symbols) {
      await dbRun("INSERT OR IGNORE INTO wishlist_symbols (wishlist_id, symbol) VALUES (?, ?)", [inserted.id, symbol]);
    }
  }
  if (userIds.length) {
    console.log(`Migrated single per-user wishlists into named lists for ${userIds.length} user(s).`);
  }
}

async function initDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new sqlite3.Database(DB_PATH, (error) => {
    if (error) {
      console.error("Failed to open SQLite database:", error.message);
    }
  });

  await dbRun(`
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
  await dbRun("ALTER TABLE market_snapshots ADD COLUMN crossed_back_below_70 INTEGER NOT NULL DEFAULT 0").catch((error) => {
    if (!/duplicate column/i.test(error.message)) {
      console.error("Failed to add sell crossover column:", error.message);
    }
  });
  await dbRun("CREATE INDEX IF NOT EXISTS idx_market_snapshots_symbol_observed ON market_snapshots(symbol, observed_at)");

  await dbRun(`
    CREATE TABLE IF NOT EXISTS whatsapp_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await refreshWhatsAppGroupCache();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS paper_trade_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_key TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL,
      signal TEXT NOT NULL,
      side TEXT NOT NULL,
      status TEXT NOT NULL,
      order_id TEXT,
      detail TEXT,
      observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await dbRun("CREATE INDEX IF NOT EXISTS idx_paper_trade_created ON paper_trade_executions(created_at)");

  await dbRun(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await loadWatchlistSelection();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const userColumnMigrations = [
    "ALTER TABLE users ADD COLUMN email TEXT",
    "ALTER TABLE users ADD COLUMN phone_number TEXT",
    "ALTER TABLE users ADD COLUMN full_name TEXT",
    "ALTER TABLE users ADD COLUMN date_of_birth TEXT",
    "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE users ADD COLUMN email_verified_at TEXT",
    "ALTER TABLE users ADD COLUMN phone_verified_at TEXT",
    "ALTER TABLE users ADD COLUMN email_otp_hash TEXT",
    "ALTER TABLE users ADD COLUMN email_otp_expires_at TEXT",
    "ALTER TABLE users ADD COLUMN email_otp_sent_at TEXT",
    "ALTER TABLE users ADD COLUMN updated_at TEXT"
  ];
  for (const migration of userColumnMigrations) {
    await dbRun(migration).catch((error) => {
      if (!/duplicate column/i.test(error.message)) {
        console.error(`User table migration failed ("${migration}"): ${error.message}`);
      }
    });
  }
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL");
  await dbRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number) WHERE phone_number IS NOT NULL");
  await ensureDefaultAdmin();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_watchlist_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, symbol)
    )
  `);
  await migrateGlobalWishlistToAdmin();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS wishlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS wishlist_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wishlist_id INTEGER NOT NULL REFERENCES wishlists(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(wishlist_id, symbol)
    )
  `);
  await migrateSingleWishlistsToNamedLists();

  await dbRun(`
    CREATE TABLE IF NOT EXISTS portfolio_holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      quantity REAL NOT NULL,
      avg_cost REAL NOT NULL,
      purchase_date TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, symbol)
    )
  `);
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
  const dailySymbols = dailyTopStocks.symbols.length ? dailyTopStocks.symbols : DEFAULT_SYMBOLS;
  const availableSymbols = Array.from(new Set([...dailySymbols, ...manualSymbols])).slice(0, MAX_SYMBOLS);
  trackedSymbols = selectedWatchSymbols === null
    ? availableSymbols
    : availableSymbols.filter((symbol) => selectedWatchSymbols.has(symbol));
  return trackedSymbols;
}

function normalizeTopStockQuotes(quotes) {
  return normalizeSymbols((quotes || [])
    .filter((quote) => !quote.quoteType || ["EQUITY", "ETF"].includes(quote.quoteType))
    .map((quote) => quote.symbol))
    .slice(0, TOP_STOCK_COUNT);
}

function firstFinanceResult(json) {
  if (!json || !json.finance) return null;
  return Array.isArray(json.finance.result)
    ? json.finance.result[0]
    : json.finance.result;
}

function sortScreenerRows(rows, sortKey, direction = "desc") {
  const sign = direction === "asc" ? 1 : -1;
  const numericAccessors = {
    change: (row) => row.todayChangePercent,
    price: (row) => row.price,
    volume: (row) => row.volume,
    avgVolume: (row) => row.avgVolume,
    relativeVolume: (row) => row.relativeVolume,
    rsi: (row) => row.rsi,
    previousRsi: (row) => row.previousRsi,
    marketCap: (row) => row.marketCap,
    pe: (row) => row.trailingPE,
    dividendYield: (row) => row.dividendYield,
    shortFloat: (row) => row.shortPercentFloat,
    analystRecom: (row) => row.analystRecommendationMean,
    targetPrice: (row) => row.targetMeanPrice,
    sharesOutstanding: (row) => row.sharesOutstanding,
    float: (row) => row.floatShares
  };
  const stringAccessors = {
    symbol: (row) => String(row.symbol || ""),
    signal: (row) => String(row.state || ""),
    company: (row) => String(row.name || ""),
    sector: (row) => String(row.sector || ""),
    industry: (row) => String(row.industry || ""),
    country: (row) => String(row.country || ""),
    exchange: (row) => String(row.exchange || "")
  };

  if (numericAccessors[sortKey]) {
    const accessor = numericAccessors[sortKey];
    return [...rows].sort((a, b) => {
      const first = accessor(a);
      const second = accessor(b);
      const firstValue = Number.isFinite(first) ? first : -Infinity;
      const secondValue = Number.isFinite(second) ? second : -Infinity;
      return (firstValue - secondValue) * sign;
    });
  }

  const accessor = stringAccessors[sortKey] || stringAccessors.symbol;
  return [...rows].sort((a, b) => accessor(a).localeCompare(accessor(b)) * sign);
}

async function getScreenerSymbols(preset, query, limit = 30) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 30, MAX_SYMBOLS));
  const normalizedQuery = String(query || "").trim();
  if (normalizedQuery) {
    const matches = await searchSymbols(normalizedQuery);
    return matches.map((item) => item.symbol).slice(0, normalizedLimit);
  }

  const presetConfig = SCREENER_PRESETS.get(preset) || SCREENER_PRESETS.get("most-active");
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(presetConfig.scrId)}&count=${normalizedLimit}`;
  const json = await requestJson(url);
  const result = firstFinanceResult(json);
  return normalizeSymbols(((result && result.quotes) || []).map((quote) => quote.symbol)).slice(0, normalizedLimit);
}

function filterScreenerRows(rows, params) {
  const optionalNumber = (name) => {
    const value = params.get(name);
    if (value === null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const optionalText = (name) => {
    const value = String(params.get(name) || "").trim();
    return value ? value.toLowerCase() : null;
  };
  const minPrice = optionalNumber("minPrice");
  const maxPrice = optionalNumber("maxPrice");
  const minVolume = optionalNumber("minVolume");
  const minAvgVolume = optionalNumber("minAvgVolume");
  const minRelativeVolume = optionalNumber("minRelativeVolume");
  const minMarketCap = optionalNumber("minMarketCap");
  const maxMarketCap = optionalNumber("maxMarketCap");
  const minPE = optionalNumber("minPE");
  const maxPE = optionalNumber("maxPE");
  const minDividendYield = optionalNumber("minDividendYield");
  const minShortFloat = optionalNumber("minShortFloat");
  const maxAnalystRecommendation = optionalNumber("maxAnalystRecommendation");
  const minTargetPrice = optionalNumber("minTargetPrice");
  const maxTargetPrice = optionalNumber("maxTargetPrice");
  const minSharesOutstanding = optionalNumber("minSharesOutstanding");
  const minFloat = optionalNumber("minFloat");
  const earningsWithinDays = optionalNumber("earningsWithinDays");
  const exchange = optionalText("exchange");
  const sector = optionalText("sector");
  const industry = optionalText("industry");
  const country = optionalText("country");
  const signal = String(params.get("signal") || "all");

  const now = Date.now();

  return rows.filter((row) => {
    if (signal !== "all" && row.state !== signal) return false;
    if (minPrice !== null && (!Number.isFinite(row.price) || row.price < minPrice)) return false;
    if (maxPrice !== null && (!Number.isFinite(row.price) || row.price > maxPrice)) return false;
    if (minVolume !== null && (!Number.isFinite(row.volume) || row.volume < minVolume)) return false;
    if (minAvgVolume !== null && (!Number.isFinite(row.avgVolume) || row.avgVolume < minAvgVolume)) return false;
    if (minRelativeVolume !== null && (!Number.isFinite(row.relativeVolume) || row.relativeVolume < minRelativeVolume)) return false;
    if (minMarketCap !== null && (!Number.isFinite(row.marketCap) || row.marketCap < minMarketCap)) return false;
    if (maxMarketCap !== null && (!Number.isFinite(row.marketCap) || row.marketCap > maxMarketCap)) return false;
    if (minPE !== null && (!Number.isFinite(row.trailingPE) || row.trailingPE < minPE)) return false;
    if (maxPE !== null && (!Number.isFinite(row.trailingPE) || row.trailingPE > maxPE)) return false;
    if (minDividendYield !== null && (!Number.isFinite(row.dividendYield) || row.dividendYield < minDividendYield)) return false;
    if (minShortFloat !== null && (!Number.isFinite(row.shortPercentFloat) || row.shortPercentFloat < minShortFloat)) return false;
    if (maxAnalystRecommendation !== null && (!Number.isFinite(row.analystRecommendationMean) || row.analystRecommendationMean > maxAnalystRecommendation)) return false;
    if (minTargetPrice !== null && (!Number.isFinite(row.targetMeanPrice) || row.targetMeanPrice < minTargetPrice)) return false;
    if (maxTargetPrice !== null && (!Number.isFinite(row.targetMeanPrice) || row.targetMeanPrice > maxTargetPrice)) return false;
    if (minSharesOutstanding !== null && (!Number.isFinite(row.sharesOutstanding) || row.sharesOutstanding < minSharesOutstanding)) return false;
    if (minFloat !== null && (!Number.isFinite(row.floatShares) || row.floatShares < minFloat)) return false;
    if (earningsWithinDays !== null) {
      const earningsTime = row.earningsDate ? Date.parse(row.earningsDate) : NaN;
      if (!Number.isFinite(earningsTime)) return false;
      const daysUntil = (earningsTime - now) / (24 * 60 * 60 * 1000);
      if (daysUntil < 0 || daysUntil > earningsWithinDays) return false;
    }
    if (exchange && !String(row.exchange || "").toLowerCase().includes(exchange)) return false;
    if (sector && String(row.sector || "").toLowerCase() !== sector) return false;
    if (industry && !String(row.industry || "").toLowerCase().includes(industry)) return false;
    if (country && !String(row.country || "").toLowerCase().includes(country)) return false;
    return true;
  });
}

async function getScreenerData(params) {
  const preset = params.get("preset") || "most-active";
  const query = params.get("q") || "";
  const sort = params.get("sort") || "volume";
  const direction = params.get("direction") === "asc" ? "asc" : "desc";
  const limit = params.get("limit") || 30;
  const symbols = await getScreenerSymbols(preset, query, limit);
  const settled = await Promise.allSettled(symbols.map(getSymbolData));
  const rows = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      symbol: symbols[index],
      error: result.reason.message,
      state: "ERROR",
      updatedAt: new Date().toISOString()
    };
  });

  const validSymbols = rows.filter((row) => row.state !== "ERROR").map((row) => row.symbol);
  const [fundamentals, profiles] = await Promise.all([
    getBulkQuoteFundamentals(validSymbols),
    getBulkQuoteProfiles(validSymbols)
  ]);
  rows.forEach((row) => {
    const extra = fundamentals[row.symbol];
    row.name = extra ? extra.name : null;
    row.marketCap = extra ? extra.marketCap : null;
    row.trailingPE = extra ? extra.trailingPE : null;
    row.dividendYield = extra ? extra.dividendYield : null;
    row.exchange = extra ? extra.exchange : null;
    row.fiftyTwoWeekHigh = extra ? extra.fiftyTwoWeekHigh : null;
    row.fiftyTwoWeekLow = extra ? extra.fiftyTwoWeekLow : null;

    const profile = profiles[row.symbol];
    row.sector = profile ? profile.sector : null;
    row.industry = profile ? profile.industry : null;
    row.country = profile ? profile.country : null;
    row.analystRecommendation = profile ? profile.analystRecommendation : null;
    row.analystRecommendationMean = profile ? profile.analystRecommendationMean : null;
    row.targetMeanPrice = profile ? profile.targetMeanPrice : null;
    row.shortPercentFloat = profile ? profile.shortPercentFloat : null;
    row.floatShares = profile ? profile.floatShares : null;
    row.sharesOutstanding = profile ? profile.sharesOutstanding : null;
    row.earningsDate = profile ? profile.earningsDate : null;

    row.relativeVolume = Number.isFinite(row.volume) && Number.isFinite(row.avgVolume) && row.avgVolume > 0
      ? row.volume / row.avgVolume
      : null;
  });

  const filtered = sortScreenerRows(filterScreenerRows(rows, params), sort, direction);
  const presetConfig = SCREENER_PRESETS.get(preset) || SCREENER_PRESETS.get("most-active");

  return {
    query,
    preset,
    presetLabel: query ? "Symbol Search" : presetConfig.label,
    source: query ? "Yahoo Finance symbol search" : `Yahoo Finance ${presetConfig.label}`,
    updatedAt: new Date().toISOString(),
    count: filtered.length,
    data: filtered
  };
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
    const result = firstFinanceResult(json);
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

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      resolve(null);
      return;
    }
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row || null);
    });
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidateHash = crypto.scryptSync(password, salt, 64).toString("hex");
  const candidateBuffer = Buffer.from(candidateHash, "hex");
  const storedBuffer = Buffer.from(hash, "hex");
  if (candidateBuffer.length !== storedBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
}

async function ensureDefaultAdmin() {
  const row = await dbGet("SELECT COUNT(*) AS count FROM users");
  if (row && row.count > 0) return;
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin";
  await dbRun("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')", [username, hashPassword(password)]);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn(`Created default admin user "${username}" with password "admin" - set ADMIN_USERNAME/ADMIN_PASSWORD in .env, then sign in and change it.`);
  } else {
    console.log(`Created default admin user "${username}".`);
  }
}

let mailTransport = null;

function mailerConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getMailTransport() {
  if (!mailerConfigured()) return null;
  if (!mailTransport) {
    mailTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return mailTransport;
}

async function sendEmail(to, subject, text) {
  const transport = getMailTransport();
  if (!transport) throw new Error("Email is not configured on this server (missing SMTP_HOST/SMTP_USER/SMTP_PASS)");
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text
  });
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function calculateAge(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

async function deriveUniqueUsername(email) {
  const base = String(email).split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "") || "user";
  let candidate = base;
  let suffix = 1;
  while (await dbGet("SELECT id FROM users WHERE username = ?", [candidate])) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }
  return candidate;
}

async function sendVerificationOtp(userId, email) {
  const code = generateOtpCode();
  const now = Date.now();
  await dbRun(
    "UPDATE users SET email_otp_hash = ?, email_otp_expires_at = ?, email_otp_sent_at = ? WHERE id = ?",
    [hashPassword(code), new Date(now + EMAIL_OTP_TTL_MS).toISOString(), new Date(now).toISOString(), userId]
  );
  await sendEmail(
    email,
    "Your Market Dashboard verification code",
    `Your verification code is ${code}. It expires in 10 minutes.`
  );
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const separator = pair.indexOf("=");
    if (separator < 0) return;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    email: user.email || null,
    role: user.role,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (token) sessions.delete(token);
}

// Sessions cache role/status at login time. When an admin changes a user's role
// or deactivates them, any of that user's already-open sessions need to be
// updated (role change) or dropped (no longer active) immediately - otherwise
// a promoted admin can't see admin pages, and a suspended user keeps full
// access, until they happen to log out and back in.
function syncSessionsForUser(userId, { role, active }) {
  for (const [token, session] of sessions.entries()) {
    if (session.userId !== userId) continue;
    if (active === false) {
      sessions.delete(token);
    } else if (role) {
      session.role = role;
    }
  }
}

function setSessionCookie(res, token) {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function requireAdminUser(req) {
  const user = getSessionUser(req);
  return user && user.role === "admin" ? user : null;
}

async function loadWatchlistSelection() {
  try {
    const rows = await dbAll("SELECT key, value FROM app_settings WHERE key IN ('watchlist_symbols', 'manual_watchlist_symbols')");
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    manualSymbols = settings.manual_watchlist_symbols
      ? normalizeSymbols(JSON.parse(settings.manual_watchlist_symbols)).slice(0, MAX_SYMBOLS)
      : [];
    if (!settings.watchlist_symbols) {
      selectedWatchSymbols = null;
    } else {
      selectedWatchSymbols = new Set(normalizeSymbols(JSON.parse(settings.watchlist_symbols)));
    }
    syncTrackedSymbols();
  } catch (error) {
    console.warn(`Failed to load watchlist selection: ${error.message}`);
  }
  return trackedSymbols;
}

async function saveAppSetting(key, value) {
  await dbRun(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `, [key, JSON.stringify(value)]);
}

async function saveWatchlistSelection(input) {
  const symbols = normalizeSymbols(input);
  const availableSymbols = new Set([...dailyTopStocks.symbols, ...manualSymbols]);
  const invalid = symbols.filter((symbol) => !availableSymbols.has(symbol));
  if (invalid.length) {
    throw new Error(`Only Daily Top 10 or manually added symbols can be watched: ${invalid.join(", ")}`);
  }
  await saveAppSetting("watchlist_symbols", symbols);
  selectedWatchSymbols = new Set(symbols);
  return syncTrackedSymbols();
}

async function addManualWatchlistSymbols(input) {
  const additions = normalizeSymbols(input);
  if (!additions.length) throw new Error("Enter at least one valid ticker symbol");
  const dailySet = new Set(dailyTopStocks.symbols);
  manualSymbols = Array.from(new Set([
    ...manualSymbols,
    ...additions.filter((symbol) => !dailySet.has(symbol))
  ])).slice(0, Math.max(0, MAX_SYMBOLS - dailyTopStocks.symbols.length));
  await saveAppSetting("manual_watchlist_symbols", manualSymbols);

  if (selectedWatchSymbols !== null) {
    additions.forEach((symbol) => selectedWatchSymbols.add(symbol));
    await saveAppSetting("watchlist_symbols", [...selectedWatchSymbols]);
  }
  return syncTrackedSymbols();
}

async function removeManualWatchlistSymbols(input) {
  const removals = new Set(normalizeSymbols(input));
  if (!removals.size) throw new Error("Enter at least one valid ticker symbol");
  manualSymbols = manualSymbols.filter((symbol) => !removals.has(symbol));
  await saveAppSetting("manual_watchlist_symbols", manualSymbols);

  if (selectedWatchSymbols !== null) {
    removals.forEach((symbol) => selectedWatchSymbols.delete(symbol));
    await saveAppSetting("watchlist_symbols", [...selectedWatchSymbols]);
  }
  return syncTrackedSymbols();
}

const MAX_WISHLISTS_PER_USER = 20;

async function getUserWishlists(userId) {
  return dbAll(`
    SELECT w.id, w.name, w.created_at AS createdAt, COUNT(ws.id) AS symbolCount
    FROM wishlists w
    LEFT JOIN wishlist_symbols ws ON ws.wishlist_id = w.id
    WHERE w.user_id = ?
    GROUP BY w.id
    ORDER BY w.id ASC
  `, [userId]);
}

async function getOrCreateDefaultWishlist(userId) {
  const existing = await dbGet("SELECT id FROM wishlists WHERE user_id = ? ORDER BY id ASC LIMIT 1", [userId]);
  if (existing) return existing.id;
  const created = await dbRun("INSERT INTO wishlists (user_id, name) VALUES (?, 'My Watchlist')", [userId]);
  return created.id;
}

async function resolveWishlistId(userId, wishlistId) {
  if (!wishlistId) return getOrCreateDefaultWishlist(userId);
  const owned = await dbGet("SELECT id FROM wishlists WHERE id = ? AND user_id = ?", [wishlistId, userId]);
  if (!owned) throw new Error("Wishlist not found");
  return owned.id;
}

async function createWishlist(userId, name) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Enter a wishlist name");
  const countRow = await dbGet("SELECT COUNT(*) AS count FROM wishlists WHERE user_id = ?", [userId]);
  if (countRow && countRow.count >= MAX_WISHLISTS_PER_USER) throw new Error(`You can have at most ${MAX_WISHLISTS_PER_USER} wishlists`);
  await dbRun("INSERT INTO wishlists (user_id, name) VALUES (?, ?)", [userId, trimmedName]);
  return getUserWishlists(userId);
}

async function renameWishlist(userId, wishlistId, name) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Enter a wishlist name");
  const owned = await dbGet("SELECT id FROM wishlists WHERE id = ? AND user_id = ?", [wishlistId, userId]);
  if (!owned) throw new Error("Wishlist not found");
  await dbRun("UPDATE wishlists SET name = ? WHERE id = ?", [trimmedName, wishlistId]);
  return getUserWishlists(userId);
}

async function deleteWishlist(userId, wishlistId) {
  const owned = await dbGet("SELECT id FROM wishlists WHERE id = ? AND user_id = ?", [wishlistId, userId]);
  if (!owned) throw new Error("Wishlist not found");
  await dbRun("DELETE FROM wishlists WHERE id = ?", [wishlistId]);
  return getUserWishlists(userId);
}

async function getWishlistSymbols(wishlistId) {
  const rows = await dbAll("SELECT symbol FROM wishlist_symbols WHERE wishlist_id = ? ORDER BY symbol", [wishlistId]);
  return rows.map((row) => row.symbol);
}

async function addWishlistSymbols(userId, wishlistId, input) {
  const additions = normalizeSymbols(input);
  if (!additions.length) throw new Error("Enter at least one valid ticker symbol");
  const resolvedId = await resolveWishlistId(userId, wishlistId);
  for (const symbol of additions) {
    await dbRun("INSERT OR IGNORE INTO wishlist_symbols (wishlist_id, symbol) VALUES (?, ?)", [resolvedId, symbol]);
  }
  return { wishlistId: resolvedId, symbols: await getWishlistSymbols(resolvedId) };
}

async function removeWishlistSymbols(userId, wishlistId, input) {
  const removals = normalizeSymbols(input);
  if (!removals.length) throw new Error("Enter at least one valid ticker symbol");
  const resolvedId = await resolveWishlistId(userId, wishlistId);
  for (const symbol of removals) {
    await dbRun("DELETE FROM wishlist_symbols WHERE wishlist_id = ? AND symbol = ?", [resolvedId, symbol]);
  }
  return { wishlistId: resolvedId, symbols: await getWishlistSymbols(resolvedId) };
}

async function getPortfolioHoldings(userId) {
  return dbAll(
    "SELECT symbol, quantity, avg_cost AS avgCost, purchase_date AS purchaseDate, created_at AS createdAt, updated_at AS updatedAt FROM portfolio_holdings WHERE user_id = ? ORDER BY symbol",
    [userId]
  );
}

async function addPortfolioHolding(userId, symbol, quantity, avgCost, purchaseDate) {
  const normalizedSymbols = normalizeSymbols(symbol);
  if (!normalizedSymbols.length) throw new Error("Enter a valid ticker symbol");
  const normalizedSymbol = normalizedSymbols[0];
  const qty = Number(quantity);
  const cost = Number(avgCost);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be a positive number");
  if (!Number.isFinite(cost) || cost <= 0) throw new Error("Average cost must be a positive number");

  const existing = await dbGet("SELECT quantity, avg_cost AS avgCost FROM portfolio_holdings WHERE user_id = ? AND symbol = ?", [userId, normalizedSymbol]);
  const now = new Date().toISOString();
  if (existing) {
    const newQuantity = existing.quantity + qty;
    const newAvgCost = (existing.quantity * existing.avgCost + qty * cost) / newQuantity;
    await dbRun(
      "UPDATE portfolio_holdings SET quantity = ?, avg_cost = ?, updated_at = ? WHERE user_id = ? AND symbol = ?",
      [newQuantity, newAvgCost, now, userId, normalizedSymbol]
    );
  } else {
    await dbRun(
      "INSERT INTO portfolio_holdings (user_id, symbol, quantity, avg_cost, purchase_date, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, normalizedSymbol, qty, cost, purchaseDate || null, now]
    );
  }
  return getPortfolioHoldings(userId);
}

async function setPortfolioHolding(userId, symbol, quantity, avgCost, purchaseDate) {
  const normalizedSymbols = normalizeSymbols(symbol);
  if (!normalizedSymbols.length) throw new Error("Enter a valid ticker symbol");
  const normalizedSymbol = normalizedSymbols[0];
  const qty = Number(quantity);
  const cost = Number(avgCost);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be a positive number");
  if (!Number.isFinite(cost) || cost <= 0) throw new Error("Average cost must be a positive number");

  await dbRun(
    `INSERT INTO portfolio_holdings (user_id, symbol, quantity, avg_cost, purchase_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, symbol) DO UPDATE SET quantity = excluded.quantity, avg_cost = excluded.avg_cost,
       purchase_date = excluded.purchase_date, updated_at = excluded.updated_at`,
    [userId, normalizedSymbol, qty, cost, purchaseDate || null, new Date().toISOString()]
  );
  return getPortfolioHoldings(userId);
}

async function deletePortfolioHolding(userId, symbol) {
  const normalizedSymbols = normalizeSymbols(symbol);
  if (!normalizedSymbols.length) throw new Error("Enter a valid ticker symbol");
  await dbRun("DELETE FROM portfolio_holdings WHERE user_id = ? AND symbol = ?", [userId, normalizedSymbols[0]]);
  return getPortfolioHoldings(userId);
}

async function getPortfolioWithPnl(userId) {
  const holdings = await getPortfolioHoldings(userId);
  if (!holdings.length) {
    return { holdings: [], totals: { costBasis: 0, marketValue: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0 } };
  }
  const quotes = await getMarketData(holdings.map((holding) => holding.symbol));
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));

  let totalCostBasis = 0;
  let totalMarketValue = 0;
  const enrichedHoldings = holdings.map((holding) => {
    const quote = quoteBySymbol.get(holding.symbol);
    const currentPrice = quote && Number.isFinite(quote.price) ? quote.price : null;
    const costBasis = holding.quantity * holding.avgCost;
    const marketValue = currentPrice !== null ? holding.quantity * currentPrice : null;
    const unrealizedPnl = marketValue !== null ? marketValue - costBasis : null;
    const unrealizedPnlPercent = marketValue !== null && costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : null;
    totalCostBasis += costBasis;
    if (marketValue !== null) totalMarketValue += marketValue;
    return {
      ...holding,
      currentPrice,
      costBasis,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPercent,
      todayChangePercent: quote ? quote.todayChangePercent : null
    };
  });

  const totalUnrealizedPnl = totalMarketValue - totalCostBasis;
  return {
    holdings: enrichedHoldings,
    totals: {
      costBasis: totalCostBasis,
      marketValue: totalMarketValue,
      unrealizedPnl: totalUnrealizedPnl,
      unrealizedPnlPercent: totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis) * 100 : 0
    }
  };
}

function watchlistPayload() {
  return {
    topStocks: dailyTopStocks,
    symbols: trackedSymbols,
    selectedSymbols: selectedWatchSymbols === null
      ? Array.from(new Set([...dailyTopStocks.symbols, ...manualSymbols]))
      : Array.from(new Set([...dailyTopStocks.symbols, ...manualSymbols])).filter((symbol) => selectedWatchSymbols.has(symbol)),
    selectionConfigured: selectedWatchSymbols !== null,
    manualSymbols: [...manualSymbols]
  };
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

async function getBulkQuoteFundamentals(symbols) {
  const normalizedSymbols = normalizeSymbols(symbols);
  if (!normalizedSymbols.length) return {};

  const result = {};
  const uncached = [];
  normalizedSymbols.forEach((symbol) => {
    const cached = quoteFundamentalsCache.get(symbol);
    if (cached && Date.now() - cached.cachedAt < QUOTE_FUNDAMENTALS_CACHE_MS) {
      result[symbol] = cached.data;
    } else {
      uncached.push(symbol);
    }
  });
  if (!uncached.length) return result;

  const fetchQuotes = async (auth) => {
    const crumbQuery = auth && auth.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(uncached.join(","))}${crumbQuery}`;
    return requestJson(url, auth && auth.cookie ? { Cookie: auth.cookie } : {});
  };

  try {
    let json;
    try {
      json = await fetchQuotes(await getYahooAuth());
    } catch (error) {
      json = await fetchQuotes(await getYahooAuth(true));
    }
    const quotes = (json.quoteResponse && Array.isArray(json.quoteResponse.result)) ? json.quoteResponse.result : [];
    quotes.forEach((quote) => {
      if (!quote || !quote.symbol) return;
      const data = {
        name: quote.longName || quote.shortName || null,
        marketCap: Number.isFinite(quote.marketCap) ? quote.marketCap : null,
        trailingPE: Number.isFinite(quote.trailingPE) ? quote.trailingPE : null,
        dividendYield: Number.isFinite(quote.dividendYield) ? quote.dividendYield : null,
        exchange: quote.fullExchangeName || quote.exchange || null,
        fiftyTwoWeekHigh: Number.isFinite(quote.fiftyTwoWeekHigh) ? quote.fiftyTwoWeekHigh : null,
        fiftyTwoWeekLow: Number.isFinite(quote.fiftyTwoWeekLow) ? quote.fiftyTwoWeekLow : null
      };
      quoteFundamentalsCache.set(quote.symbol, { cachedAt: Date.now(), data });
      result[quote.symbol] = data;
    });
  } catch (error) {
    console.warn(`Bulk quote fundamentals unavailable: ${error.message}`);
  }

  return result;
}

async function getQuoteProfile(symbol) {
  const cached = quoteProfileCache.get(symbol);
  if (cached && Date.now() - cached.cachedAt < QUOTE_PROFILE_CACHE_MS) {
    return cached.data;
  }

  const fetchProfile = async (auth) => {
    const crumbQuery = auth && auth.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
    const modules = "assetProfile,financialData,defaultKeyStatistics,calendarEvents";
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}${crumbQuery}`;
    return requestJson(url, auth && auth.cookie ? { Cookie: auth.cookie } : {});
  };

  let data = {
    sector: null,
    industry: null,
    country: null,
    analystRecommendation: null,
    analystRecommendationMean: null,
    targetMeanPrice: null,
    shortPercentFloat: null,
    floatShares: null,
    sharesOutstanding: null,
    earningsDate: null
  };

  try {
    let json;
    try {
      json = await fetchProfile(await getYahooAuth());
    } catch (error) {
      json = await fetchProfile(await getYahooAuth(true));
    }
    const result = json.quoteSummary && Array.isArray(json.quoteSummary.result) && json.quoteSummary.result[0];
    if (result) {
      const profile = result.assetProfile || {};
      const financial = result.financialData || {};
      const stats = result.defaultKeyStatistics || {};
      const earnings = (result.calendarEvents && result.calendarEvents.earnings) || {};
      const earningsDates = Array.isArray(earnings.earningsDate) ? earnings.earningsDate : [];
      const firstEarningsDate = earningsDates[0];

      data = {
        sector: profile.sector || null,
        industry: profile.industry || null,
        country: profile.country || null,
        analystRecommendation: financial.recommendationKey || null,
        analystRecommendationMean: Number.isFinite(financial.recommendationMean && financial.recommendationMean.raw)
          ? financial.recommendationMean.raw
          : null,
        targetMeanPrice: Number.isFinite(financial.targetMeanPrice && financial.targetMeanPrice.raw)
          ? financial.targetMeanPrice.raw
          : null,
        shortPercentFloat: Number.isFinite(stats.shortPercentOfFloat && stats.shortPercentOfFloat.raw)
          ? stats.shortPercentOfFloat.raw * 100
          : null,
        floatShares: Number.isFinite(stats.floatShares && stats.floatShares.raw) ? stats.floatShares.raw : null,
        sharesOutstanding: Number.isFinite(stats.sharesOutstanding && stats.sharesOutstanding.raw)
          ? stats.sharesOutstanding.raw
          : null,
        earningsDate: Number.isFinite(firstEarningsDate && firstEarningsDate.raw)
          ? new Date(firstEarningsDate.raw * 1000).toISOString()
          : null
      };
    }
  } catch (error) {
    console.warn(`Quote profile unavailable for ${symbol}: ${error.message}`);
  }

  quoteProfileCache.set(symbol, { cachedAt: Date.now(), data });
  return data;
}

async function getBulkQuoteProfiles(symbols) {
  const normalizedSymbols = normalizeSymbols(symbols);
  if (!normalizedSymbols.length) return {};
  const settled = await Promise.all(normalizedSymbols.map(getQuoteProfile));
  const result = {};
  normalizedSymbols.forEach((symbol, index) => {
    result[symbol] = settled[index];
  });
  return result;
}

const MARKET_TICKER_SYMBOLS = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^DJI", label: "Dow Jones" },
  { symbol: "^IXIC", label: "Nasdaq" },
  { symbol: "^RUT", label: "Russell 2000" },
  { symbol: "^VIX", label: "VIX" },
  { symbol: "GC=F", label: "Gold" },
  { symbol: "SI=F", label: "Silver" },
  { symbol: "CL=F", label: "Crude Oil" },
  { symbol: "NG=F", label: "Natural Gas" }
];
const MARKET_TICKER_CACHE_MS = 5 * 1000;
let marketTickerCache = null;
let marketTickerCachedAt = 0;

async function getQuoteSnapshot(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const json = await requestJson(url);
  const result = json.chart && json.chart.result && json.chart.result[0];
  const meta = (result && result.meta) || {};
  const price = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : null;
  const previousClose = Number.isFinite(meta.chartPreviousClose)
    ? meta.chartPreviousClose
    : Number.isFinite(meta.previousClose)
      ? meta.previousClose
      : null;
  if (!Number.isFinite(price)) {
    throw new Error(`No price data for ${symbol}`);
  }
  const changePercent = Number.isFinite(previousClose) && previousClose !== 0
    ? ((price - previousClose) / previousClose) * 100
    : null;
  return {
    symbol,
    price: Number(price.toFixed(2)),
    changePercent: Number.isFinite(changePercent) ? Number(changePercent.toFixed(2)) : null
  };
}

async function getMarketTicker(force = false) {
  if (!force && marketTickerCache && Date.now() - marketTickerCachedAt < MARKET_TICKER_CACHE_MS) {
    return marketTickerCache;
  }
  const settled = await Promise.allSettled(MARKET_TICKER_SYMBOLS.map((item) => getQuoteSnapshot(item.symbol)));
  const items = MARKET_TICKER_SYMBOLS.map((item, index) => {
    const result = settled[index];
    if (result.status === "fulfilled") {
      return { ...result.value, label: item.label };
    }
    return { symbol: item.symbol, label: item.label, price: null, changePercent: null, error: result.reason.message };
  });
  marketTickerCache = { updatedAt: new Date().toISOString(), items };
  marketTickerCachedAt = Date.now();
  return marketTickerCache;
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

function exponentialAverage(values, period) {
  if (!values.length) return null;
  const multiplier = 2 / (period + 1);
  return values.slice(1).reduce((average, value) =>
    average + (value - average) * multiplier, values[0]);
}

function annualizedVolatility(returns) {
  if (!returns.length) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

function nextMonthlyOptionDate(minimumDays = 28) {
  const minimum = new Date();
  minimum.setUTCDate(minimum.getUTCDate() + minimumDays);
  for (let offset = 0; offset < 8; offset += 1) {
    const first = new Date(Date.UTC(minimum.getUTCFullYear(), minimum.getUTCMonth() + offset, 1));
    const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
    const thirdFriday = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), firstFriday + 14));
    if (thirdFriday >= minimum) return thirdFriday.toISOString().slice(0, 10);
  }
  return minimum.toISOString().slice(0, 10);
}

function classifyTrend({ spot, ema20, ema50, rsi, return20 }) {
  const aboveEma = spot > ema20 && ema20 > ema50;
  const belowEma = spot < ema20 && ema20 < ema50;
  if (aboveEma && return20 >= 5 && rsi < 85) return "strong-bull";
  if (belowEma && return20 <= -5 && rsi > 22) return "strong-bear";
  if (spot >= ema20 && ema20 >= ema50 && return20 > 0 && rsi >= 45 && rsi <= 72) return "mild-bull";
  if (spot <= ema20 && ema20 <= ema50 && return20 < 0 && rsi <= 55 && rsi >= 28) return "mild-bear";
  if (Math.abs(return20) <= 3 && rsi >= 42 && rsi <= 58) return "neutral";
  return "choppy";
}

function classifyVolatility({ volatility20, expansion }) {
  const level = volatility20 >= 0.35 ? "extreme" : volatility20 >= 0.22 ? "elevated" : "low";
  const trend = expansion >= 1.15 ? "expanding" : expansion <= 0.85 ? "contracting" : "stable";
  return { level, trend, rich: level !== "low" };
}

function clampConfidence(value) { return Math.max(50, Math.min(88, Math.round(value))); }

function chooseStrategy(trend, vol, { rsi, return20, expansion, volatility20 }) {
  const expansionBoost = Math.max(0, expansion - 1) * 30;

  if (trend === "strong-bull") {
    if (rsi > 75 && vol.trend === "expanding") {
      return { recommendation: "protective-put", confidence: clampConfidence(55 + expansionBoost + (rsi - 75)), rationale: "The uptrend is strong but extended and realized volatility is expanding, so a protective put hedges downside risk on an existing position while keeping full upside." };
    }
    if (vol.trend === "expanding") {
      return { recommendation: "long-call", confidence: clampConfidence(60 + expansionBoost + Math.min(10, return20 / 2)), rationale: "Price, EMA alignment, and 20-day return are strongly bullish while realized volatility is expanding, favoring an uncapped long call to ride continuation." };
    }
    if (vol.rich) {
      return { recommendation: "bull-call-spread", confidence: clampConfidence(62 + Math.min(15, return20)), rationale: "Price, EMA alignment, and 20-day return are bullish, and premiums are rich enough that a defined-risk bull call spread is more efficient than a naked call." };
    }
    return { recommendation: "long-call", confidence: clampConfidence(58 + Math.min(15, return20)), rationale: "Price, EMA alignment, and 20-day return are bullish with cheap realized volatility, favoring an uncapped long call over a spread." };
  }

  if (trend === "strong-bear") {
    if (vol.trend === "expanding") {
      return { recommendation: "long-put", confidence: clampConfidence(60 + expansionBoost + Math.min(10, Math.abs(return20) / 2)), rationale: "Price, EMA alignment, and 20-day return are strongly bearish while realized volatility is expanding, favoring an uncapped long put to ride continuation." };
    }
    return { recommendation: "bear-put-spread", confidence: clampConfidence(62 + Math.min(15, Math.abs(return20))), rationale: "Price, EMA alignment, and 20-day return are bearish, favoring a defined-risk bear put spread." };
  }

  if (trend === "mild-bull") {
    if (vol.trend === "expanding" && vol.rich) {
      return { recommendation: "collar", confidence: clampConfidence(55 + expansionBoost), rationale: "The bias is mildly bullish but realized volatility is expanding, favoring a zero/low-cost collar to cap upside in exchange for downside protection." };
    }
    if (vol.rich) {
      return { recommendation: "bull-put-spread", confidence: clampConfidence(58 + volatility20 * 40), rationale: "The bias is mildly bullish and premiums are rich, favoring a bull put credit spread over paying for calls." };
    }
    if (rsi < 50) {
      return { recommendation: "cash-secured-put", confidence: clampConfidence(56 + (50 - rsi) / 2), rationale: "Trend is mildly bullish with cheap realized volatility and RSI below neutral, favoring a cash-secured put to acquire shares at a discount." };
    }
    return { recommendation: "covered-call", confidence: clampConfidence(58 + Math.max(0, return20) * 1.5), rationale: "Trend and RSI are neutral-to-bullish without strong volatility expansion, favoring covered-call income for an existing 100-share position." };
  }

  if (trend === "mild-bear") {
    if (vol.rich) {
      return { recommendation: "bear-call-spread", confidence: clampConfidence(58 + volatility20 * 40), rationale: "The bias is mildly bearish and premiums are rich, favoring a bear call credit spread." };
    }
    return { recommendation: "bear-put-spread", confidence: clampConfidence(56 + Math.abs(return20) * 1.5), rationale: "The bias is mildly bearish with cheap realized volatility, favoring a defined-risk bear put spread over selling credit." };
  }

  if (trend === "neutral") {
    if (vol.level === "extreme" && vol.trend === "stable") {
      return { recommendation: "short-straddle", confidence: clampConfidence(62 + volatility20 * 35), rationale: "Price is pinned near the middle of its range while realized volatility is extremely elevated and steady, favoring a short straddle to harvest rich at-the-money premium." };
    }
    if ((vol.level === "extreme" && vol.trend === "contracting") || (vol.level === "elevated" && vol.trend === "contracting")) {
      return { recommendation: "short-strangle", confidence: clampConfidence(60 + volatility20 * 30), rationale: "Price is range-bound while realized volatility is elevated but starting to cool, favoring a short strangle to collect fading premium with a wider range than a straddle." };
    }
    if (vol.level === "elevated" && vol.trend === "stable") {
      return { recommendation: "iron-condor", confidence: clampConfidence(60 + volatility20 * 35), rationale: "Price is range-bound while realized volatility is elevated but not expanding, favoring a defined-risk premium-selling iron condor." };
    }
    if (vol.level === "low" && vol.trend === "expanding") {
      return { recommendation: "long-straddle", confidence: clampConfidence(58 + expansionBoost), rationale: "Realized volatility is cheap but starting to expand with no clear direction, favoring an at-the-money long straddle before premiums get pricier." };
    }
    if (vol.trend === "expanding") {
      return { recommendation: "long-strangle", confidence: clampConfidence(58 + expansionBoost * (vol.level === "extreme" ? 1.15 : 1)), rationale: "Recent realized volatility is expanding with no clear direction, favoring a long strangle if the future move exceeds premiums paid." };
    }
    if (vol.trend === "contracting") {
      return { recommendation: "call-butterfly", confidence: clampConfidence(55 + (1 - volatility20) * 20), rationale: "Price is pinned near the middle of its range with thin and shrinking realized volatility, favoring a cheap debit call butterfly over selling scarce premium." };
    }
    return { recommendation: "iron-butterfly", confidence: clampConfidence(58 + volatility20 * 30), rationale: "Price is pinned near the middle of its range with steady realized volatility, favoring an iron butterfly to collect at-the-money premium with defined risk." };
  }

  if ((vol.level === "extreme" || (vol.rich && vol.trend === "expanding"))) {
    return { recommendation: "long-strangle", confidence: clampConfidence(55 + expansionBoost), rationale: "Trend signals conflict, but realized volatility is elevated and expanding, favoring a long strangle since direction matters less than the size of the move." };
  }
  return { recommendation: "wait", confidence: 68, rationale: "The move is unusually directional or extended and trend signals conflict; neither a directional nor volatility-based strategy has a clean model fit, so waiting is safer than forcing a trade." };
}

async function getOptionStrategyAnalysis(symbol) {
  const normalizedSymbol = normalizeSymbols(symbol)[0];
  if (!normalizedSymbol) throw new Error("A valid symbol is required");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalizedSymbol)}?range=6mo&interval=1d`;
  const json = await requestJson(url);
  const result = json.chart && json.chart.result && json.chart.result[0];
  const quote = result && result.indicators && result.indicators.quote && result.indicators.quote[0];
  const closes = quote && Array.isArray(quote.close)
    ? quote.close.filter(Number.isFinite)
    : [];
  if (closes.length < 55) throw new Error("Not enough daily history for strategy analysis");

  const spot = closes[closes.length - 1];
  const returns = closes.slice(1).map((value, index) => Math.log(value / closes[index])).filter(Number.isFinite);
  const volatility20 = annualizedVolatility(returns.slice(-20));
  const recentVolatility = annualizedVolatility(returns.slice(-10));
  const priorVolatility = annualizedVolatility(returns.slice(-30, -10));
  const expansion = priorVolatility > 0 ? recentVolatility / priorVolatility : 1;
  const ema20 = exponentialAverage(closes.slice(-60), 20);
  const ema50 = exponentialAverage(closes, 50);
  const return20 = ((spot / closes[closes.length - 21]) - 1) * 100;
  const rsiValues = rsiSeries(closes);
  const rsi = rsiValues[rsiValues.length - 1];
  const trend = classifyTrend({ spot, ema20, ema50, rsi, return20 });
  const vol = classifyVolatility({ volatility20, expansion });
  const { recommendation, confidence, rationale } = chooseStrategy(trend, vol, { rsi, return20, expansion, volatility20 });

  const expiration = nextMonthlyOptionDate(28);
  const volatilityProxy = Math.max(10, Math.min(150, volatility20 * 100));
  return {
    symbol: normalizedSymbol,
    updatedAt: new Date().toISOString(),
    spot: Number(spot.toFixed(2)),
    expiration,
    volatilityProxy: Number(volatilityProxy.toFixed(2)),
    coveredCallStrike: Math.max(1, Math.round(spot * 1.05)),
    stranglePutStrike: Math.max(0.5, Math.round(spot * 0.98)),
    strangleCallStrike: Math.max(1, Math.round(spot * 1.02)),
    recommendation,
    confidence,
    rationale,
    metrics: {
      rsi: Number(rsi.toFixed(2)),
      ema20: Number(ema20.toFixed(2)),
      ema50: Number(ema50.toFixed(2)),
      return20: Number(return20.toFixed(2)),
      realizedVolatility20: Number((volatility20 * 100).toFixed(2)),
      volatilityExpansion: Number(expansion.toFixed(2))
    }
  };
}

const optionChainCache = new Map();
const OPTION_CHAIN_CACHE_MS = 20 * 1000;

function normalizeOptionContract(contract) {
  return {
    contractSymbol: contract.contractSymbol || null,
    strike: Number.isFinite(contract.strike) ? contract.strike : null,
    bid: Number.isFinite(contract.bid) ? contract.bid : null,
    ask: Number.isFinite(contract.ask) ? contract.ask : null,
    lastPrice: Number.isFinite(contract.lastPrice) ? contract.lastPrice : null,
    change: Number.isFinite(contract.change) ? contract.change : null,
    percentChange: Number.isFinite(contract.percentChange) ? contract.percentChange : null,
    volume: Number.isFinite(contract.volume) ? contract.volume : null,
    openInterest: Number.isFinite(contract.openInterest) ? contract.openInterest : null,
    impliedVolatility: Number.isFinite(contract.impliedVolatility) ? contract.impliedVolatility * 100 : null,
    inTheMoney: Boolean(contract.inTheMoney)
  };
}

async function getOptionChain(symbol, expiration) {
  const normalizedSymbol = normalizeSymbols(symbol)[0];
  if (!normalizedSymbol) throw new Error("A valid symbol is required");
  const normalizedExpiration = /^\d+$/.test(String(expiration || "")) ? String(expiration) : "";
  const cacheKey = `${normalizedSymbol}:${normalizedExpiration || "default"}`;
  const cached = optionChainCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < OPTION_CHAIN_CACHE_MS) {
    return cached.data;
  }

  const dateQuery = normalizedExpiration ? `&date=${encodeURIComponent(normalizedExpiration)}` : "";
  const fetchChain = async (auth) => {
    const crumbQuery = auth && auth.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
    const url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(normalizedSymbol)}?formatted=false${dateQuery}${crumbQuery}`;
    return requestJson(url, auth && auth.cookie ? { Cookie: auth.cookie } : {});
  };

  let json;
  try {
    json = await fetchChain(await getYahooAuth());
  } catch (error) {
    json = await fetchChain(await getYahooAuth(true));
  }
  const result = json.optionChain && Array.isArray(json.optionChain.result) && json.optionChain.result[0];
  if (!result) {
    const chainError = json.optionChain && json.optionChain.error;
    throw new Error((chainError && chainError.description) || `No option chain available for ${normalizedSymbol}`);
  }

  const quote = result.quote || {};
  const optionsBlock = (Array.isArray(result.options) && result.options[0]) || {};
  const data = {
    symbol: normalizedSymbol,
    price: Number.isFinite(quote.regularMarketPrice) ? quote.regularMarketPrice : null,
    change: Number.isFinite(quote.regularMarketChange) ? quote.regularMarketChange : null,
    changePercent: Number.isFinite(quote.regularMarketChangePercent) ? quote.regularMarketChangePercent : null,
    expirationDates: Array.isArray(result.expirationDates) ? result.expirationDates : [],
    selectedExpiration: optionsBlock.expirationDate || null,
    calls: Array.isArray(optionsBlock.calls)
      ? optionsBlock.calls.map(normalizeOptionContract).sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0))
      : [],
    puts: Array.isArray(optionsBlock.puts)
      ? optionsBlock.puts.map(normalizeOptionContract).sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0))
      : [],
    updatedAt: new Date().toISOString()
  };
  optionChainCache.set(cacheKey, { cachedAt: Date.now(), data });
  return data;
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
    .filter((quote) => quote.symbol)
    .filter((quote) => !quote.quoteType || ["EQUITY", "ETF"].includes(quote.quoteType))
    .map((quote) => ({
      symbol: String(quote.symbol).toUpperCase(),
      name: quote.longname || quote.shortname || quote.symbol,
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

function requestRaw(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          ...extraHeaders
        }
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode, headers: response.headers, body });
        });
      }
    );

    request.setTimeout(8000, () => {
      request.destroy(new Error("Quote request timed out"));
    });

    request.on("error", reject);
  });
}

function requestJson(url, extraHeaders = {}) {
  return requestRaw(url, extraHeaders).then(({ statusCode, body }) => {
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Quote request failed with ${statusCode}`);
    }
    return JSON.parse(body);
  });
}

let yahooAuthCache = null;
const YAHOO_AUTH_CACHE_MS = 55 * 60 * 1000;

async function getYahooAuth(force = false) {
  if (!force && yahooAuthCache && Date.now() - yahooAuthCache.cachedAt < YAHOO_AUTH_CACHE_MS) {
    return yahooAuthCache;
  }
  const cookieResponse = await requestRaw("https://fc.yahoo.com");
  const setCookie = cookieResponse.headers["set-cookie"] || [];
  const cookie = setCookie.map((entry) => entry.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Unable to establish a Yahoo Finance session");

  const crumbResponse = await requestRaw("https://query2.finance.yahoo.com/v1/test/getcrumb", { Cookie: cookie, Accept: "*/*" });
  const crumb = (crumbResponse.body || "").trim();
  if (!crumb || crumb.startsWith("<")) throw new Error("Unable to obtain a Yahoo Finance crumb");

  yahooAuthCache = { cookie, crumb, cachedAt: Date.now() };
  return yahooAuthCache;
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
          "User-Agent": "Mozilla/5.0",
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

const earningsCalendarCache = new Map();
const EARNINGS_CALENDAR_CACHE_MS = 15 * 60 * 1000;

function addDaysToMarketDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return marketDateKey(date);
}

async function getEarningsCalendar(params) {
  const daysBack = Math.max(0, Math.min(Number(params.get("daysBack")) || 0, 30));
  const daysAheadRaw = params.has("days") ? Number(params.get("days")) : (daysBack > 0 ? 0 : 14);
  const daysAhead = Math.max(0, Math.min(daysAheadRaw || 0, 60));
  const startDate = daysBack > 0 ? addDaysToMarketDate(-daysBack) : marketDateKey();
  const endDate = addDaysToMarketDate(Math.max(daysAhead, 1));
  const query = String(params.get("q") || "").trim().toLowerCase();

  const cacheKey = `${startDate}:${endDate}`;
  let data = earningsCalendarCache.get(cacheKey);
  if (!data || Date.now() - data.cachedAt >= EARNINGS_CALENDAR_CACHE_MS) {
    const fetchCalendar = async (auth) => {
      const crumbQuery = auth && auth.crumb ? `?crumb=${encodeURIComponent(auth.crumb)}` : "";
      const url = `https://query1.finance.yahoo.com/v1/finance/visualization${crumbQuery}`;
      const body = await requestJsonPost(url, auth && auth.cookie ? { Cookie: auth.cookie } : {}, {
        sortField: "startdatetime",
        sortType: "ASC",
        entityIdType: "earnings",
        includeFields: ["ticker", "companyshortname", "startdatetime", "startdatetimetype", "epsestimate", "epsactual", "epssurprisepct"],
        query: {
          operator: "and",
          operands: [
            { operator: "gte", operands: ["startdatetime", startDate] },
            { operator: "lt", operands: ["startdatetime", endDate] },
            { operator: "eq", operands: ["region", "us"] }
          ]
        },
        offset: 0,
        size: 250
      }, "Earnings calendar");
      const json = JSON.parse(body);
      if (json.finance && json.finance.error) {
        throw new Error(json.finance.error.description || "Earnings calendar request failed");
      }
      return json;
    };

    let json;
    try {
      json = await fetchCalendar(await getYahooAuth());
    } catch (error) {
      json = await fetchCalendar(await getYahooAuth(true));
    }

    const result = json.finance && Array.isArray(json.finance.result) && json.finance.result[0];
    const document = result && Array.isArray(result.documents) && result.documents[0];
    const rows = document && Array.isArray(document.rows) ? document.rows : [];

    const rawEvents = rows
      .map((row) => ({
        symbol: row[0],
        company: row[1],
        date: row[2],
        timing: row[3] || null,
        epsEstimate: Number.isFinite(row[4]) ? row[4] : null,
        epsActual: Number.isFinite(row[5]) ? row[5] : null,
        epsSurprisePercent: Number.isFinite(row[6]) ? row[6] : null
      }))
      .filter((event) => event.symbol && event.date);

    // Collapse duplicate preferred-share listings (e.g. JPM-PC, JPM-PD) into
    // a single row per company per day, preferring the common-stock ticker.
    const dedupedByCompanyDay = new Map();
    rawEvents.forEach((event) => {
      const baseSymbol = event.symbol.split("-")[0];
      const key = `${baseSymbol}|${event.date}`;
      const existing = dedupedByCompanyDay.get(key);
      const isCommonStock = !event.symbol.includes("-");
      if (!existing || (isCommonStock && existing.symbol.includes("-"))) {
        dedupedByCompanyDay.set(key, { ...event, symbol: isCommonStock ? event.symbol : baseSymbol });
      }
    });
    const events = [...dedupedByCompanyDay.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

    data = {
      cachedAt: Date.now(),
      startDate,
      endDate,
      total: result ? result.total : events.length,
      events
    };
    earningsCalendarCache.set(cacheKey, data);
  }

  const filteredEvents = query
    ? data.events.filter((event) => event.symbol.toLowerCase().includes(query) || String(event.company || "").toLowerCase().includes(query))
    : data.events;

  return {
    startDate: data.startDate,
    endDate: data.endDate,
    total: data.total,
    count: filteredEvents.length,
    updatedAt: new Date(data.cachedAt).toISOString(),
    events: filteredEvents
  };
}

const economicCalendarDayCache = new Map();
const ECONOMIC_CALENDAR_CACHE_MS = 15 * 60 * 1000;

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .trim();
}

function stripHtmlTags(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function fetchEconomicEventsForDate(dateKey) {
  const cached = economicCalendarDayCache.get(dateKey);
  if (cached && Date.now() - cached.cachedAt < ECONOMIC_CALENDAR_CACHE_MS) {
    return cached.rows;
  }

  const body = await requestJson(`https://api.nasdaq.com/api/calendar/economicevents?date=${dateKey}`, {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json"
  });
  const rawRows = (body && body.data && Array.isArray(body.data.rows)) ? body.data.rows : [];

  const rows = rawRows.map((row) => {
    const actual = decodeHtmlEntities(row.actual);
    const consensus = decodeHtmlEntities(row.consensus);
    const previous = decodeHtmlEntities(row.previous);
    return {
      date: dateKey,
      time: row.gmt || null,
      country: row.country || "Unknown",
      event: row.eventName || "Untitled event",
      actual: actual || null,
      consensus: consensus || null,
      previous: previous || null,
      description: stripHtmlTags(row.description)
    };
  });

  economicCalendarDayCache.set(dateKey, { cachedAt: Date.now(), rows });
  return rows;
}

async function getEconomicCalendar(params) {
  const daysAhead = Math.max(1, Math.min(Number(params.get("days")) || 7, 14));
  const country = String(params.get("country") || "United States").trim();
  const query = String(params.get("q") || "").trim().toLowerCase();
  const startDate = marketDateKey();

  const dateKeys = [];
  for (let i = 0; i < daysAhead; i += 1) {
    dateKeys.push(addDaysToDateKey(startDate, i));
  }
  const endDate = dateKeys[dateKeys.length - 1];

  const rowsByDay = await Promise.all(dateKeys.map((dateKey) => fetchEconomicEventsForDate(dateKey)));
  let events = rowsByDay.flat();

  if (country && country.toLowerCase() !== "all") {
    events = events.filter((event) => event.country.toLowerCase() === country.toLowerCase());
  }
  if (query) {
    events = events.filter((event) => (
      event.event.toLowerCase().includes(query) || event.country.toLowerCase().includes(query)
    ));
  }

  events.sort((a, b) => `${a.date}T${a.time || "00:00"}`.localeCompare(`${b.date}T${b.time || "00:00"}`));

  return {
    startDate,
    endDate,
    count: events.length,
    updatedAt: new Date().toISOString(),
    events
  };
}

const AI_PREDICTION_MODEL = "claude-haiku-4-5";
const aiPredictionCache = new Map();
const AI_PREDICTION_CACHE_MS = 20 * 60 * 1000;
let anthropicClient = null;

function aiPredictionConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

async function getAiPrediction(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbols(symbol)[0];
  if (!normalizedSymbol) {
    throw new Error("A valid symbol is required");
  }
  if (!aiPredictionConfigured()) {
    const error = new Error("AI predictions require an ANTHROPIC_API_KEY to be configured on the server");
    error.statusCode = 503;
    throw error;
  }

  const cached = aiPredictionCache.get(normalizedSymbol);
  if (!options.force && cached && Date.now() - cached.cachedAt < AI_PREDICTION_CACHE_MS) {
    return cached.data;
  }

  const technicals = await getSymbolData(normalizedSymbol);
  const relativeVolume = Number.isFinite(technicals.volume) && Number.isFinite(technicals.avgVolume) && technicals.avgVolume > 0
    ? technicals.volume / technicals.avgVolume
    : null;
  const fundamentals = await getBulkQuoteFundamentals([normalizedSymbol]);
  const companyName = fundamentals[normalizedSymbol] ? fundamentals[normalizedSymbol].name : null;

  const prompt = `Analyze this intraday technical snapshot for ${normalizedSymbol} and give a short-term trading verdict.

Price: $${technicals.price}
Today's change: ${technicals.todayChangePercent}%
RSI (14): ${technicals.rsi} (previous reading: ${technicals.previousRsi})
Rule-based signal state: ${technicals.state}
Current volume: ${technicals.volume ?? "unknown"}
Average volume: ${technicals.avgVolume ?? "unknown"}
Relative volume: ${relativeVolume ? relativeVolume.toFixed(2) : "unknown"}
Recent 1-minute closing prices, oldest to newest: ${technicals.chart.map((value) => Number(value.toFixed(2))).join(", ")}`;

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: AI_PREDICTION_MODEL,
    max_tokens: 500,
    tools: [{
      name: "provide_prediction",
      description: "Provide a structured intraday trading verdict for the stock based on the technical data given.",
      input_schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["BUY", "SELL", "HOLD"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          reasoning: { type: "string", description: "1-3 sentence rationale referencing the technical data provided" }
        },
        required: ["verdict", "confidence", "reasoning"],
        additionalProperties: false
      },
      strict: true
    }],
    tool_choice: { type: "tool", name: "provide_prediction" },
    messages: [{ role: "user", content: prompt }]
  });

  const toolUse = response.content.find((block) => block.type === "tool_use" && block.name === "provide_prediction");
  if (!toolUse) {
    throw new Error("AI prediction did not return a structured verdict");
  }

  const data = {
    symbol: normalizedSymbol,
    companyName,
    verdict: toolUse.input.verdict,
    confidence: toolUse.input.confidence,
    reasoning: toolUse.input.reasoning,
    basis: {
      price: technicals.price,
      todayChangePercent: technicals.todayChangePercent,
      rsi: technicals.rsi,
      previousRsi: technicals.previousRsi,
      state: technicals.state,
      relativeVolume: relativeVolume ? Number(relativeVolume.toFixed(2)) : null
    },
    generatedAt: new Date().toISOString()
  };

  aiPredictionCache.set(normalizedSymbol, { data, cachedAt: Date.now() });
  return data;
}

async function getAiPredictions(symbolsParam, options = {}) {
  const symbols = normalizeSymbols(symbolsParam).slice(0, 25);
  if (!symbols.length) {
    throw new Error("At least one valid symbol is required");
  }
  const results = await Promise.allSettled(symbols.map((symbol) => getAiPrediction(symbol, options)));
  return results.map((result, index) => result.status === "fulfilled"
    ? result.value
    : { symbol: symbols[index], error: result.reason.message });
}

function alpacaConfigured() {
  return Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

function paperTradingEnabled() {
  return process.env.ALPACA_PAPER_TRADING_ENABLED === "true" &&
    alpacaConfigured() &&
    ALPACA_ALLOWED_SYMBOLS.size > 0;
}

function alpacaRequest(method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : "";
    const parsed = new URL(pathname, ALPACA_PAPER_URL);
    const request = https.request({
      hostname: parsed.hostname,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: {
        Accept: "application/json",
        "APCA-API-KEY-ID": process.env.ALPACA_API_KEY_ID || "",
        "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET_KEY || "",
        ...(body ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        } : {})
      }
    }, (response) => {
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        let data = null;
        try {
          data = responseBody ? JSON.parse(responseBody) : null;
        } catch {
          data = responseBody;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = data && typeof data === "object" && data.message
            ? data.message
            : String(responseBody || `HTTP ${response.statusCode}`).slice(0, 240);
          const error = new Error(`Alpaca paper API rejected the request (${response.statusCode}): ${message}`);
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        resolve(data);
      });
    });

    request.setTimeout(8000, () => {
      request.destroy(new Error("Alpaca paper API request timed out"));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function recentPaperTrades(limit = 20) {
  return dbAll(`
    SELECT symbol, signal, side, status, order_id AS orderId, detail,
      observed_at AS observedAt, created_at AS createdAt
    FROM paper_trade_executions
    ORDER BY id DESC
    LIMIT ?
  `, [Math.max(1, Math.min(Number(limit) || 20, 50))]);
}

async function tradingStatus() {
  const configured = alpacaConfigured();
  return {
    provider: "Alpaca",
    environment: "paper",
    configured,
    enabled: paperTradingEnabled(),
    enableFlag: process.env.ALPACA_PAPER_TRADING_ENABLED === "true",
    allowedSymbols: [...ALPACA_ALLOWED_SYMBOLS],
    buyNotional: ALPACA_BUY_NOTIONAL,
    maxDailyOrders: ALPACA_MAX_DAILY_ORDERS,
    sellBehavior: "Close an existing long position only",
    recent: await recentPaperTrades()
  };
}

async function dailyPaperOrderCount(dateKey) {
  const rows = await dbAll(`
    SELECT COUNT(*) AS count
    FROM paper_trade_executions
    WHERE status = 'submitted' AND execution_key LIKE ?
  `, [`${dateKey}:%`]);
  return Number(rows[0] && rows[0].count) || 0;
}

async function recordPaperExecution(execution) {
  await dbRun(`
    INSERT INTO paper_trade_executions (
      execution_key, symbol, signal, side, status, order_id, detail, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    execution.key,
    execution.symbol,
    execution.signal,
    execution.side,
    execution.status,
    execution.orderId || null,
    execution.detail || null,
    execution.observedAt
  ]);
}

async function updatePaperExecution(key, status, orderId, detail) {
  await dbRun(`
    UPDATE paper_trade_executions
    SET status = ?, order_id = ?, detail = ?
    WHERE execution_key = ?
  `, [status, orderId || null, detail || null, key]);
}

function paperExecutionKey(item, observedAt) {
  return `${marketDateKey(new Date(observedAt))}:${item.symbol}:${item.executionKeyType || item.state}`;
}

async function submitPaperTrade(item, observedAt) {
  const isBuy = item.state === "BUY SIGNAL";
  const side = isBuy ? "buy" : "sell";
  const key = paperExecutionKey(item, observedAt);
  if (tradingExecutionsInFlight.has(key)) return "duplicate";
  tradingExecutionsInFlight.add(key);

  try {
    await recordPaperExecution({
      key,
      symbol: item.symbol,
      signal: item.executionLabel || item.state,
      side,
      status: "pending",
      detail: isBuy ? `Buy up to $${ALPACA_BUY_NOTIONAL.toFixed(2)}` : "Close existing long position",
      observedAt
    });
  } catch (error) {
    tradingExecutionsInFlight.delete(key);
    if (/UNIQUE constraint/i.test(error.message)) return "duplicate";
    throw error;
  }

  try {
    let order;
    if (isBuy) {
      order = await alpacaRequest("POST", "/v2/orders", {
        symbol: item.symbol,
        notional: ALPACA_BUY_NOTIONAL.toFixed(2),
        side: "buy",
        type: "market",
        time_in_force: "day",
        client_order_id: `rsi-${marketDateKey(new Date(observedAt)).replaceAll("-", "")}-${item.symbol}${item.orderSource ? `-${item.orderSource}` : ""}-b`
      });
    } else {
      let position;
      try {
        position = await alpacaRequest("GET", `/v2/positions/${encodeURIComponent(item.symbol)}`);
      } catch (error) {
        if (error.statusCode === 404) {
          await updatePaperExecution(key, "skipped", null, "No long position to close");
          return "skipped";
        }
        throw error;
      }
      const quantity = Number(position && position.qty);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        await updatePaperExecution(key, "skipped", null, "No long position to close");
        return "skipped";
      }
      order = await alpacaRequest("POST", "/v2/orders", {
        symbol: item.symbol,
        qty: String(position.qty),
        side: "sell",
        type: "market",
        time_in_force: "day",
        client_order_id: `rsi-${marketDateKey(new Date(observedAt)).replaceAll("-", "")}-${item.symbol}${item.orderSource ? `-${item.orderSource}` : ""}-s`
      });
    }
    await updatePaperExecution(key, "submitted", order && order.id, order && order.status ? order.status : "Order accepted");
    return "submitted";
  } catch (error) {
    await updatePaperExecution(key, "failed", null, error.message.slice(0, 500));
    throw error;
  } finally {
    tradingExecutionsInFlight.delete(key);
  }
}

async function executePaperTrades(data, observedAt) {
  if (!paperTradingEnabled() || !Array.isArray(data) || paperTradeBatchRunning) return;
  const signals = data.filter((item) =>
    item &&
    ["BUY SIGNAL", "SELL SIGNAL"].includes(item.state) &&
    ALPACA_ALLOWED_SYMBOLS.has(item.symbol)
  );
  if (!signals.length) return;

  paperTradeBatchRunning = true;
  try {
    const clock = await alpacaRequest("GET", "/v2/clock");
    if (!clock || !clock.is_open) return;

    const dateKey = marketDateKey(new Date(observedAt));
    let dailyCount = await dailyPaperOrderCount(dateKey);
    for (const item of signals) {
      if (dailyCount >= ALPACA_MAX_DAILY_ORDERS) break;
      try {
        const result = await submitPaperTrade(item, observedAt);
        if (result === "submitted") dailyCount += 1;
      } catch (error) {
        console.warn(`Paper trade failed for ${item.symbol}: ${error.message}`);
      }
    }
  } finally {
    paperTradeBatchRunning = false;
  }
}

async function executeBulkPaperTrades(inputSymbols, side) {
  if (!paperTradingEnabled()) {
    throw new Error("Alpaca paper trading is not enabled and fully configured");
  }
  if (paperTradeBatchRunning) throw new Error("Another paper-trading batch is already running");

  const normalizedSide = String(side || "").toLowerCase();
  if (!["buy", "sell"].includes(normalizedSide)) throw new Error("Side must be buy or sell");
  const symbols = normalizeSymbols(inputSymbols);
  if (!symbols.length) throw new Error("Select at least one watched symbol");

  const invalid = symbols.filter((symbol) =>
    !trackedSymbols.includes(symbol) || !ALPACA_ALLOWED_SYMBOLS.has(symbol)
  );
  if (invalid.length) {
    throw new Error(`Symbols must be both watched and Alpaca-allowed: ${invalid.join(", ")}`);
  }

  paperTradeBatchRunning = true;
  try {
    const clock = await alpacaRequest("GET", "/v2/clock");
    if (!clock || !clock.is_open) throw new Error("The stock market is currently closed");

    const observedAt = new Date().toISOString();
    const dateKey = marketDateKey(new Date(observedAt));
    let dailyCount = await dailyPaperOrderCount(dateKey);
    const results = [];

    for (const symbol of symbols) {
      if (dailyCount >= ALPACA_MAX_DAILY_ORDERS) {
        results.push({ symbol, status: "skipped", detail: "Daily paper-order limit reached" });
        continue;
      }
      try {
        const status = await submitPaperTrade({
          symbol,
          state: normalizedSide === "buy" ? "BUY SIGNAL" : "SELL SIGNAL",
          executionKeyType: `BULK ${normalizedSide.toUpperCase()}`,
          executionLabel: `MANUAL BULK ${normalizedSide.toUpperCase()}`,
          orderSource: "bulk"
        }, observedAt);
        results.push({ symbol, status });
        if (status === "submitted") dailyCount += 1;
      } catch (error) {
        results.push({ symbol, status: "failed", detail: error.message });
      }
    }
    return {
      provider: "Alpaca",
      environment: "paper",
      side: normalizedSide,
      results,
      recent: await recentPaperTrades()
    };
  } finally {
    paperTradeBatchRunning = false;
  }
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

async function getMarketData(symbols) {
  await refreshDailyTopStocks();
  const list = symbols || trackedSymbols;
  const settled = await Promise.allSettled(list.map(getSymbolData));
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      symbol: list[index],
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

function sendStatic(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const requested = parsedUrl.pathname === "/" ? "/search.html" : parsedUrl.pathname;
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

const PUBLIC_PATHS = new Set([
  "/login.html",
  "/register.html",
  "/api/auth/login",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/guest",
  "/api/auth/register",
  "/api/auth/verify-email",
  "/api/auth/resend-otp"
]);
const STATIC_ASSET_PATTERN = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map)$/i;
const ADMIN_ONLY_PAGES = new Set(["/admin.html", "/admin-users.html", "/admin-stocks.html"]);

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const isHtmlNavigation = req.method === "GET" && (parsedUrl.pathname === "/" || parsedUrl.pathname.endsWith(".html"));

  if (!PUBLIC_PATHS.has(parsedUrl.pathname) && !STATIC_ASSET_PATTERN.test(parsedUrl.pathname)) {
    const sessionUser = getSessionUser(req);
    if (!sessionUser) {
      if (isHtmlNavigation) {
        const next = encodeURIComponent(parsedUrl.pathname + parsedUrl.search);
        res.writeHead(302, { Location: `/login.html?next=${next}` });
        res.end();
      } else {
        sendError(res, 401, "Sign in required");
      }
      return;
    }
    if (ADMIN_ONLY_PAGES.has(parsedUrl.pathname) && sessionUser.role !== "admin") {
      res.writeHead(302, { Location: "/index.html" });
      res.end();
      return;
    }
  }

  if (parsedUrl.pathname === "/api/market") {
    (async () => {
      try {
        const sessionUser = getSessionUser(req);
        if (!sessionUser) {
          sendError(res, 401, "Sign in required");
          return;
        }
        const isAdmin = sessionUser.role === "admin";
        const viewAll = isAdmin && parsedUrl.searchParams.get("view") === "all";
        const symbolsOverride = parsedUrl.searchParams.has("symbols")
          ? normalizeSymbols(parsedUrl.searchParams.get("symbols"))
          : null;
        const requestedWishlistId = Number(parsedUrl.searchParams.get("wishlistId")) || null;
        // The main dashboard shows the signed-in user's selected wishlist by default
        // (their first/default one if none is specified); a brand-new user with an
        // empty wishlist falls back to the shared tracked pool. Admins can still opt
        // into the full Daily Top 10 pool via ?view=all. An explicit ?symbols= override
        // (used by guests, whose wishlist lives in browser localStorage rather than the
        // database) takes precedence over all of that.
        let activeWishlistId = null;
        let personalSymbols = [];
        if (!symbolsOverride && sessionUser.userId) {
          activeWishlistId = await resolveWishlistId(sessionUser.userId, requestedWishlistId);
          personalSymbols = await getWishlistSymbols(activeWishlistId);
        }
        const symbolsForRequest = symbolsOverride
          ? symbolsOverride
          : viewAll
            ? dailyTopStocks.symbols
            : (personalSymbols.length ? personalSymbols : trackedSymbols);

        const data = await getMarketData(symbolsForRequest);
        const observedAt = new Date().toISOString();
        if (!viewAll) {
          saveMarketSnapshot(data, observedAt);
          notifyCrossovers(data, observedAt).catch((error) => {
            console.warn(`Notification module failed: ${error.message}`);
          });
          executePaperTrades(data, observedAt).catch((error) => {
            console.warn(`Paper trading module failed: ${error.message}`);
          });
        }
        sendJson(res, {
          symbols: symbolsForRequest,
          personalSymbols,
          activeWishlistId,
          topStocks: dailyTopStocks,
          updatedAt: observedAt,
          data,
          isAdmin,
          viewingAll: viewAll
        });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/watchlist/symbols") {
    (async () => {
      try {
        const sessionUser = getSessionUser(req);
        if (!sessionUser) {
          sendError(res, 401, "Sign in required");
          return;
        }
        if (!sessionUser.userId) {
          sendError(res, 403, "Guests use a browser-local wishlist. Create an account to save one on the server.");
          return;
        }
        if (req.method === "POST") {
          const payload = await readJsonBody(req);
          const result = await addWishlistSymbols(sessionUser.userId, payload.wishlistId, payload.symbols);
          sendJson(res, result);
          return;
        }
        if (req.method === "DELETE") {
          const payload = await readJsonBody(req);
          const result = await removeWishlistSymbols(sessionUser.userId, payload.wishlistId, payload.symbols);
          sendJson(res, result);
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/wishlists") {
    (async () => {
      try {
        const sessionUser = getSessionUser(req);
        if (!sessionUser) {
          sendError(res, 401, "Sign in required");
          return;
        }
        if (!sessionUser.userId) {
          sendError(res, 403, "Guests use a browser-local wishlist and can't create additional lists.");
          return;
        }
        if (req.method === "GET") {
          const wishlists = await getUserWishlists(sessionUser.userId);
          sendJson(res, { wishlists });
          return;
        }
        if (req.method === "POST") {
          const payload = await readJsonBody(req);
          const wishlists = await createWishlist(sessionUser.userId, payload.name);
          sendJson(res, { wishlists });
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname.startsWith("/api/wishlists/")) {
    (async () => {
      try {
        const sessionUser = getSessionUser(req);
        if (!sessionUser) {
          sendError(res, 401, "Sign in required");
          return;
        }
        if (!sessionUser.userId) {
          sendError(res, 403, "Guests use a browser-local wishlist and can't manage additional lists.");
          return;
        }
        const wishlistId = Number(parsedUrl.pathname.split("/").pop());
        if (req.method === "PUT") {
          const payload = await readJsonBody(req);
          const wishlists = await renameWishlist(sessionUser.userId, wishlistId, payload.name);
          sendJson(res, { wishlists });
          return;
        }
        if (req.method === "DELETE") {
          const wishlists = await deleteWishlist(sessionUser.userId, wishlistId);
          sendJson(res, { wishlists });
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/portfolio") {
    (async () => {
      try {
        const sessionUser = getSessionUser(req);
        if (!sessionUser) {
          sendError(res, 401, "Sign in required");
          return;
        }
        if (!sessionUser.userId) {
          sendError(res, 403, "Guests can't track a portfolio. Create an account to save one.");
          return;
        }
        if (req.method === "GET") {
          sendJson(res, await getPortfolioWithPnl(sessionUser.userId));
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          await addPortfolioHolding(sessionUser.userId, body.symbol, body.quantity, body.avg_cost, body.purchase_date);
          sendJson(res, await getPortfolioWithPnl(sessionUser.userId));
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname.startsWith("/api/portfolio/")) {
    (async () => {
      try {
        const sessionUser = getSessionUser(req);
        if (!sessionUser) {
          sendError(res, 401, "Sign in required");
          return;
        }
        if (!sessionUser.userId) {
          sendError(res, 403, "Guests can't track a portfolio. Create an account to save one.");
          return;
        }
        const symbol = decodeURIComponent(parsedUrl.pathname.split("/").pop());
        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          await setPortfolioHolding(sessionUser.userId, symbol, body.quantity, body.avg_cost, body.purchase_date);
          sendJson(res, await getPortfolioWithPnl(sessionUser.userId));
          return;
        }
        if (req.method === "DELETE") {
          await deletePortfolioHolding(sessionUser.userId, symbol);
          sendJson(res, await getPortfolioWithPnl(sessionUser.userId));
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/auth/login" && req.method === "POST") {
    (async () => {
      try {
        const body = await readJsonBody(req);
        const identifier = String(body.email || body.username || "").trim();
        const password = String(body.password || "");
        if (!identifier || !password) throw new Error("Email and password are required");
        const user = await dbGet(
          "SELECT id, username, email, password_hash, role, status FROM users WHERE email = ? OR username = ?",
          [identifier, identifier]
        );
        if (!user || !verifyPassword(password, user.password_hash)) {
          sendError(res, 401, "Invalid email or password");
          return;
        }
        if (user.status === "pending") {
          sendError(res, 403, "Your account is awaiting admin approval.");
          return;
        }
        if (user.status !== "active") {
          sendError(res, 403, `Your account is ${user.status}. Contact an admin for access.`);
          return;
        }
        const token = createSession(user);
        setSessionCookie(res, token);
        sendJson(res, { username: user.username, email: user.email, role: user.role });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/auth/guest" && req.method === "POST") {
    const token = createSession({ id: null, username: "Guest", role: "guest" });
    setSessionCookie(res, token);
    sendJson(res, { username: "Guest", role: "guest" });
    return;
  }

  if (parsedUrl.pathname === "/api/auth/register" && req.method === "POST") {
    (async () => {
      try {
        const body = await readJsonBody(req);
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");
        const fullName = String(body.full_name || "").trim();
        const phoneNumber = String(body.phone_number || "").trim();
        const dateOfBirth = String(body.date_of_birth || "").trim();

        if (!isValidEmail(email)) throw new Error("Enter a valid email address");
        if (password.length < 6) throw new Error("Password must be at least 6 characters");
        if (!fullName) throw new Error("Full name is required");
        const age = calculateAge(dateOfBirth);
        if (age === null) throw new Error("Enter a valid date of birth");
        if (age < MIN_REGISTRATION_AGE) throw new Error(`You must be at least ${MIN_REGISTRATION_AGE} to register`);
        if (!mailerConfigured()) throw new Error("Email verification is not configured on this server yet. Ask an admin to set SMTP_HOST/SMTP_USER/SMTP_PASS.");

        const existing = await dbGet("SELECT id FROM users WHERE email = ?", [email]);
        if (existing) throw new Error("An account with that email already exists");

        const username = await deriveUniqueUsername(email);
        const insertResult = await dbRun(
          `INSERT INTO users (username, email, phone_number, password_hash, full_name, date_of_birth, role, status)
           VALUES (?, ?, ?, ?, ?, ?, 'user', 'pending')`,
          [username, email, phoneNumber || null, hashPassword(password), fullName, dateOfBirth]
        );
        await sendVerificationOtp(insertResult.id, email);
        sendJson(res, { email, message: "Account created. Check your email for a verification code." });
      } catch (error) {
        const message = /UNIQUE constraint failed/.test(error.message) ? "An account with that email or phone already exists" : error.message;
        sendError(res, 400, message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/auth/verify-email" && req.method === "POST") {
    (async () => {
      try {
        const body = await readJsonBody(req);
        const email = String(body.email || "").trim().toLowerCase();
        const code = String(body.code || "").trim();
        if (!email || !code) throw new Error("Email and code are required");

        const user = await dbGet(
          "SELECT id, email_otp_hash, email_otp_expires_at FROM users WHERE email = ?",
          [email]
        );
        if (!user || !user.email_otp_hash) throw new Error("No pending verification for this email");
        if (!user.email_otp_expires_at || new Date(user.email_otp_expires_at).getTime() < Date.now()) {
          throw new Error("That code has expired. Request a new one.");
        }
        if (!verifyPassword(code, user.email_otp_hash)) throw new Error("Incorrect verification code");

        await dbRun(
          "UPDATE users SET email_verified_at = ?, email_otp_hash = NULL, email_otp_expires_at = NULL WHERE id = ?",
          [new Date().toISOString(), user.id]
        );
        sendJson(res, { verified: true, message: "Email verified. Your account is awaiting admin approval." });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/auth/resend-otp" && req.method === "POST") {
    (async () => {
      try {
        const body = await readJsonBody(req);
        const email = String(body.email || "").trim().toLowerCase();
        if (!email) throw new Error("Email is required");
        const user = await dbGet("SELECT id, email_otp_sent_at, email_verified_at FROM users WHERE email = ?", [email]);
        if (!user) throw new Error("No account found for that email");
        if (user.email_verified_at) throw new Error("This email is already verified");
        if (user.email_otp_sent_at && Date.now() - new Date(user.email_otp_sent_at).getTime() < EMAIL_OTP_RESEND_COOLDOWN_MS) {
          throw new Error("Please wait a bit before requesting another code");
        }
        await sendVerificationOtp(user.id, email);
        sendJson(res, { message: "A new code has been sent." });
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/auth/logout" && req.method === "POST") {
    destroySession(req);
    clearSessionCookie(res);
    sendJson(res, { success: true });
    return;
  }

  if (parsedUrl.pathname === "/api/auth/me") {
    const sessionUser = getSessionUser(req);
    sendJson(res, sessionUser
      ? { username: sessionUser.username, email: sessionUser.email || null, role: sessionUser.role }
      : { username: null, role: null });
    return;
  }

  if (parsedUrl.pathname === "/api/admin/users") {
    if (!requireAdminUser(req)) {
      sendError(res, 401, "Admin sign-in is required");
      return;
    }
    (async () => {
      try {
        if (req.method === "GET") {
          const users = await dbAll(`SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY username`);
          sendJson(res, { users });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const username = String(body.username || "").trim();
          const email = String(body.email || "").trim().toLowerCase();
          const password = String(body.password || "");
          const role = body.role === "admin" ? "admin" : "user";
          const fullName = String(body.full_name || "").trim();
          const phoneNumber = String(body.phone_number || "").trim();
          const dateOfBirth = String(body.date_of_birth || "").trim();
          if (username.length < 3) throw new Error("Username must be at least 3 characters");
          if (!isValidEmail(email)) throw new Error("Enter a valid email address");
          if (password.length < 6) throw new Error("Password must be at least 6 characters");
          // Admin-created accounts are approved by construction - no OTP/pending step.
          await dbRun(
            `INSERT INTO users (username, email, phone_number, password_hash, full_name, date_of_birth, role, status, email_verified_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
            [username, email, phoneNumber || null, hashPassword(password), fullName || null, dateOfBirth || null, role, new Date().toISOString()]
          );
          const users = await dbAll(`SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY username`);
          sendJson(res, { users });
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        const message = /UNIQUE constraint failed/.test(error.message) ? "That username or email is already taken" : error.message;
        sendError(res, 400, message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname.startsWith("/api/admin/users/")) {
    if (!requireAdminUser(req)) {
      sendError(res, 401, "Admin sign-in is required");
      return;
    }
    (async () => {
      try {
        const id = Number(parsedUrl.pathname.split("/").pop());
        const target = await dbGet("SELECT id, role FROM users WHERE id = ?", [id]);
        if (!target) throw new Error("User not found");

        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          if (body.role !== undefined) {
            const nextRole = body.role === "admin" ? "admin" : "user";
            if (target.role === "admin" && nextRole !== "admin") {
              const adminCountRow = await dbGet("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
              if (adminCountRow && adminCountRow.count <= 1) throw new Error("Cannot demote the last admin");
            }
            await dbRun("UPDATE users SET role = ? WHERE id = ?", [nextRole, id]);
            syncSessionsForUser(id, { role: nextRole });
          }
          if (body.status !== undefined) {
            const validStatuses = new Set(["pending", "active", "suspended", "closed"]);
            const nextStatus = validStatuses.has(body.status) ? body.status : "active";
            if (target.role === "admin" && nextStatus !== "active") {
              const activeAdminCountRow = await dbGet("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'");
              if (activeAdminCountRow && activeAdminCountRow.count <= 1) throw new Error("Cannot deactivate the last active admin");
            }
            await dbRun("UPDATE users SET status = ? WHERE id = ?", [nextStatus, id]);
            if (nextStatus !== "active") syncSessionsForUser(id, { active: false });
          }
          if (body.email_verified !== undefined) {
            await dbRun("UPDATE users SET email_verified_at = ? WHERE id = ?", [body.email_verified ? new Date().toISOString() : null, id]);
          }
          if (body.phone_verified !== undefined) {
            await dbRun("UPDATE users SET phone_verified_at = ? WHERE id = ?", [body.phone_verified ? new Date().toISOString() : null, id]);
          }
          if (body.username !== undefined) {
            const nextUsername = String(body.username).trim();
            if (nextUsername.length < 3) throw new Error("Username must be at least 3 characters");
            await dbRun("UPDATE users SET username = ? WHERE id = ?", [nextUsername, id]);
          }
          if (body.email !== undefined) {
            const nextEmail = String(body.email).trim().toLowerCase();
            if (nextEmail && !isValidEmail(nextEmail)) throw new Error("Enter a valid email address");
            await dbRun("UPDATE users SET email = ? WHERE id = ?", [nextEmail || null, id]);
          }
          if (body.full_name !== undefined) {
            await dbRun("UPDATE users SET full_name = ? WHERE id = ?", [String(body.full_name).trim() || null, id]);
          }
          if (body.phone_number !== undefined) {
            await dbRun("UPDATE users SET phone_number = ? WHERE id = ?", [String(body.phone_number).trim() || null, id]);
          }
          if (body.date_of_birth !== undefined) {
            await dbRun("UPDATE users SET date_of_birth = ? WHERE id = ?", [String(body.date_of_birth).trim() || null, id]);
          }
          if (body.password) {
            const nextPassword = String(body.password);
            if (nextPassword.length < 6) throw new Error("Password must be at least 6 characters");
            await dbRun("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(nextPassword), id]);
          }
          const users = await dbAll(`SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY username`);
          sendJson(res, { users });
          return;
        }

        if (req.method !== "DELETE") {
          sendError(res, 405, "Method not allowed");
          return;
        }
        if (target.role === "admin") {
          const adminCountRow = await dbGet("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
          if (adminCountRow && adminCountRow.count <= 1) throw new Error("Cannot remove the last admin");
        }
        await dbRun("DELETE FROM users WHERE id = ?", [id]);
        syncSessionsForUser(id, { active: false });
        const users = await dbAll(`SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY username`);
        sendJson(res, { users });
      } catch (error) {
        const message = /UNIQUE constraint failed/.test(error.message) ? "That username or email is already taken" : error.message;
        sendError(res, 400, message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/market-ticker") {
    (async () => {
      try {
        const force = parsedUrl.searchParams.get("refresh") === "1";
        sendJson(res, await getMarketTicker(force));
      } catch (error) {
        sendError(res, 500, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/top-stocks") {
    (async () => {
      try {
        const force = parsedUrl.searchParams.get("refresh") === "1";
        await refreshDailyTopStocks(force);
        sendJson(res, watchlistPayload());
      } catch (error) {
        sendError(res, 500, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/screener") {
    (async () => {
      try {
        sendJson(res, await getScreenerData(parsedUrl.searchParams));
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/earnings-calendar") {
    (async () => {
      try {
        sendJson(res, await getEarningsCalendar(parsedUrl.searchParams));
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/economic-calendar") {
    (async () => {
      try {
        sendJson(res, await getEconomicCalendar(parsedUrl.searchParams));
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/ai-prediction") {
    (async () => {
      try {
        const force = parsedUrl.searchParams.get("refresh") === "1";
        const symbolsParam = parsedUrl.searchParams.get("symbols");
        if (symbolsParam) {
          sendJson(res, { predictions: await getAiPredictions(symbolsParam, { force }) });
        } else {
          sendJson(res, await getAiPrediction(parsedUrl.searchParams.get("symbol"), { force }));
        }
      } catch (error) {
        sendError(res, error.statusCode || 400, error.message);
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

  if (parsedUrl.pathname === "/api/trading") {
    if (!requireAdminUser(req)) {
      sendError(res, 401, "Admin sign-in is required");
      return;
    }
    (async () => {
      try {
        sendJson(res, await tradingStatus());
      } catch (error) {
        sendError(res, 500, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/admin/watchlist") {
    if (!requireAdminUser(req)) {
      sendError(res, 401, "Admin sign-in is required");
      return;
    }
    (async () => {
      try {
        if (req.method === "GET") {
          sendJson(res, watchlistPayload());
          return;
        }
        if (req.method === "PUT") {
          const payload = await readJsonBody(req);
          await saveWatchlistSelection(payload.symbols);
          sendJson(res, watchlistPayload());
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/admin/watchlist/symbols") {
    if (!requireAdminUser(req)) {
      sendError(res, 401, "Admin sign-in is required");
      return;
    }
    (async () => {
      try {
        if (req.method === "POST") {
          const payload = await readJsonBody(req);
          await addManualWatchlistSymbols(payload.symbols);
          sendJson(res, watchlistPayload());
          return;
        }
        if (req.method === "DELETE") {
          const payload = await readJsonBody(req);
          await removeManualWatchlistSymbols(payload.symbols);
          sendJson(res, watchlistPayload());
          return;
        }
        sendError(res, 405, "Method not allowed");
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/admin/trading/bulk") {
    if (!requireAdminUser(req)) {
      sendError(res, 401, "Admin sign-in is required");
      return;
    }
    (async () => {
      try {
        if (req.method !== "POST") {
          sendError(res, 405, "Method not allowed");
          return;
        }
        const payload = await readJsonBody(req);
        sendJson(res, await executeBulkPaperTrades(payload.symbols, payload.side));
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/admin/whatsapp-groups") {
    if (!requireAdminUser(req)) {
      sendError(res, 401, "Admin sign-in is required");
      return;
    }
    (async () => {
      try {
        if (req.method === "GET") {
          sendJson(res, {
            protected: true,
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
    if (!requireAdminUser(req)) {
      sendError(res, 401, "Admin sign-in is required");
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

  if (parsedUrl.pathname === "/api/options-analysis") {
    (async () => {
      try {
        sendJson(res, await getOptionStrategyAnalysis(
          parsedUrl.searchParams.get("symbol") || DEFAULT_SYMBOLS[0]
        ));
      } catch (error) {
        sendError(res, 400, error.message);
      }
    })();
    return;
  }

  if (parsedUrl.pathname === "/api/option-chain") {
    (async () => {
      try {
        sendJson(res, await getOptionChain(
          parsedUrl.searchParams.get("symbol") || DEFAULT_SYMBOLS[0],
          parsedUrl.searchParams.get("expiration")
        ));
      } catch (error) {
        sendError(res, 400, error.message);
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
    sendError(res, 403, "Watchlist symbols must be selected on the Admin page");
    return;
  }

  sendStatic(req, res);
});

initDatabase()
  .then(() => syncTrackedSymbols())
  .catch((error) => {
    console.error(`Failed to initialize database: ${error.message}`);
  });

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
