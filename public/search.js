function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function formatVolume(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function formatMarketCap(value) {
  if (!Number.isFinite(value)) return "--";
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)}`;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function formatDividendYield(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}%`;
}

function formatShares(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatShortFloat(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}%`;
}

function formatRelativeVolume(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}x`;
}

const ANALYST_RECOM_LABELS = {
  strong_buy: "Strong Buy",
  buy: "Buy",
  hold: "Hold",
  underperform: "Underperform",
  sell: "Sell",
  strong_sell: "Strong Sell"
};

function formatAnalystRecom(row) {
  if (row.analystRecommendation && ANALYST_RECOM_LABELS[row.analystRecommendation]) {
    return ANALYST_RECOM_LABELS[row.analystRecommendation];
  }
  if (Number.isFinite(row.analystRecommendationMean)) return row.analystRecommendationMean.toFixed(2);
  return "--";
}

function formatEarningsDate(value) {
  if (!value) return "--";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parsed);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatTime(value) {
  if (!value) return "--";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(parsed);
}

function stateClass(value) {
  return String(value || "ERROR").replace(" ", "_");
}

/* ---------------- Stock Search (on-demand screener with filters, sort, pagination) ---------------- */

const screenerForm = document.getElementById("screenerForm");
const screenerQuery = document.getElementById("screenerQuery");
const presetSelect = document.getElementById("presetSelect");
const signalSelect = document.getElementById("signalSelect");
const minPrice = document.getElementById("minPrice");
const maxPrice = document.getElementById("maxPrice");
const minVolume = document.getElementById("minVolume");
const minAvgVolume = document.getElementById("minAvgVolume");
const minRelativeVolume = document.getElementById("minRelativeVolume");
const marketCapSelect = document.getElementById("marketCapSelect");
const maxPE = document.getElementById("maxPE");
const minDividendYield = document.getElementById("minDividendYield");
const minShortFloat = document.getElementById("minShortFloat");
const analystRecomSelect = document.getElementById("analystRecomSelect");
const minTargetPrice = document.getElementById("minTargetPrice");
const maxTargetPrice = document.getElementById("maxTargetPrice");
const sharesOutstandingSelect = document.getElementById("sharesOutstandingSelect");
const floatSelect = document.getElementById("floatSelect");
const exchangeSelect = document.getElementById("exchangeSelect");
const sectorSelect = document.getElementById("sectorSelect");
const industryQuery = document.getElementById("industryQuery");
const countryQuery = document.getElementById("countryQuery");
const earningsSelect = document.getElementById("earningsSelect");
const sortSelect = document.getElementById("sortSelect");
const sortDirectionSelect = document.getElementById("sortDirectionSelect");
const toggleAdvancedFilters = document.getElementById("toggleAdvancedFilters");
const advancedFilters = document.getElementById("advancedFilters");
const resetScreener = document.getElementById("resetScreener");
const screenerTable = document.getElementById("screenerTable");
const screenerRows = document.getElementById("screenerRows");
const screenerHelper = document.getElementById("screenerHelper");
const searchStatus = document.getElementById("searchStatus");
const searchDot = document.getElementById("searchDot");
const matchCount = document.getElementById("matchCount");
const searchBuyCount = document.getElementById("searchBuyCount");
const searchOversoldCount = document.getElementById("searchOversoldCount");
const searchUpdated = document.getElementById("searchUpdated");
const symbolSuggestions = document.getElementById("symbolSuggestions");
const sortButtons = document.querySelectorAll("[data-sort-key]");
const screenerTabs = document.querySelectorAll(".screener-tab");
const pageSizeSelect = document.getElementById("pageSizeSelect");
const pagerInfo = document.getElementById("pagerInfo");
const pagerPages = document.getElementById("pagerPages");

const SCREENER_LIMIT = 50;
const SORT_FIELD_MAP = {
  volume: "volume",
  change: "todayChangePercent",
  price: "price",
  marketCap: "marketCap",
  pe: "trailingPE",
  dividendYield: "dividendYield",
  shortFloat: "shortPercentFloat",
  analystRecom: "analystRecommendationMean",
  targetPrice: "targetMeanPrice",
  sharesOutstanding: "sharesOutstanding",
  float: "floatShares",
  avgVolume: "avgVolume",
  relativeVolume: "relativeVolume",
  rsi: "rsi",
  company: "name",
  sector: "sector",
  symbol: "symbol",
  signal: "state"
};

let symbolSearch;
let searchIsLoading = false;
let searchPendingRefresh = false;
let currentRows = [];
const aiPredictionResults = new Map();

function renderAiCell(symbol) {
  const entry = aiPredictionResults.get(symbol);
  if (!entry || entry.status === "idle") {
    return `<button type="button" class="ai-predict-btn" data-ai-symbol="${escapeHtml(symbol)}">AI</button>`;
  }
  if (entry.status === "loading") {
    return '<span class="ai-predict-loading">...</span>';
  }
  if (entry.status === "error") {
    return `<button type="button" class="ai-predict-btn ai-predict-error" data-ai-symbol="${escapeHtml(symbol)}" title="${escapeHtml(entry.error)}">Retry</button>`;
  }
  const verdictClass = entry.verdict === "BUY" ? "ai-verdict-buy" : entry.verdict === "SELL" ? "ai-verdict-sell" : "ai-verdict-hold";
  const badge = `<button type="button" class="ai-verdict-badge ${verdictClass}" data-ai-symbol="${escapeHtml(symbol)}" title="${escapeHtml(entry.reasoning || "")} (confidence: ${escapeHtml(entry.confidence || "--")})">${escapeHtml(entry.verdict)}</button>`;
  if (entry.verdict !== "BUY" && entry.verdict !== "SELL") return badge;
  const strategyLink = `<a class="ai-strategy-icon-link" href="/strategies.html?symbol=${encodeURIComponent(symbol)}" target="_blank" rel="noopener" title="Set up an option strategy for this ${entry.verdict} signal">&#128200;</a>`;
  return `${badge}${strategyLink}`;
}

async function fetchAiPrediction(symbol) {
  const existing = aiPredictionResults.get(symbol);
  if (existing && existing.status === "loading") return;
  aiPredictionResults.set(symbol, { status: "loading" });
  renderTable();
  try {
    const response = await fetch(`/api/ai-prediction?symbol=${encodeURIComponent(symbol)}`, {
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    aiPredictionResults.set(symbol, {
      status: "done",
      verdict: payload.verdict,
      confidence: payload.confidence,
      reasoning: payload.reasoning
    });
  } catch (error) {
    aiPredictionResults.set(symbol, { status: "error", error: error.message });
  }
  renderTable();
}

screenerRows.addEventListener("click", (event) => {
  const aiButton = event.target.closest("[data-ai-symbol]");
  if (aiButton) {
    fetchAiPrediction(aiButton.dataset.aiSymbol);
    return;
  }
  const wishlistButton = event.target.closest("[data-add-wishlist]");
  if (wishlistButton) {
    addToWishlist(wishlistButton.dataset.addWishlist, wishlistButton);
  }
});

async function addToWishlist(symbol, button) {
  button.disabled = true;
  button.textContent = "Adding...";
  try {
    const response = await fetch("/api/watchlist/symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: symbol })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    addedToWishlist.add(symbol);
    renderTable();
  } catch (error) {
    button.disabled = false;
    button.textContent = "+ Wishlist";
    window.alert(error.message);
  }
}

let tableSortKey = "volume";
let tableSortDirection = "desc";
let currentPage = 1;

function setSearchStatus(text, state) {
  searchStatus.textContent = text;
  searchDot.classList.toggle("live", state === "live");
  searchDot.classList.toggle("error", state === "error");
}

function getPageSize() {
  return Number(pageSizeSelect.value) || 25;
}

function sortValue(row, key) {
  const value = row[key];
  if (typeof value === "string") return value.toUpperCase();
  return Number.isFinite(value) ? value : null;
}

function compareRows(firstRow, secondRow, direction) {
  const first = sortValue(firstRow, tableSortKey);
  const second = sortValue(secondRow, tableSortKey);
  const emptyFirst = first === null || first === undefined || first === "";
  const emptySecond = second === null || second === undefined || second === "";

  // Rows missing this field always sort to the end, regardless of direction.
  if (emptyFirst && emptySecond) return 0;
  if (emptyFirst) return 1;
  if (emptySecond) return -1;

  if (typeof first === "string" || typeof second === "string") {
    return String(first).localeCompare(String(second)) * direction;
  }

  return (first - second) * direction;
}

function sortedRows() {
  const direction = tableSortDirection === "asc" ? 1 : -1;
  return [...currentRows].sort((firstRow, secondRow) => compareRows(firstRow, secondRow, direction));
}

function updateSortButtons() {
  sortButtons.forEach((button) => {
    const isActive = button.dataset.sortKey === tableSortKey;
    const icon = button.querySelector("span");
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-sort", isActive ? (tableSortDirection === "asc" ? "ascending" : "descending") : "none");
    if (icon) icon.textContent = isActive ? (tableSortDirection === "asc" ? "▲" : "▼") : "";
  });
}

function buildPageList(current, total) {
  const pages = new Set([1, total, current, current - 1, current + 1]);
  return [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
}

function renderPager(totalRows) {
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);
  const start = totalRows ? ((currentPage - 1) * pageSize) + 1 : 0;
  const end = Math.min(currentPage * pageSize, totalRows);
  pagerInfo.textContent = totalRows ? `Showing ${start}-${end} of ${totalRows}` : "0 results";

  const pages = buildPageList(currentPage, totalPages);
  let html = `<button type="button" class="pager-arrow" data-page="${currentPage - 1}"${currentPage <= 1 ? " disabled" : ""} aria-label="Previous page">&larr;</button>`;
  let previousPage = 0;
  pages.forEach((page) => {
    if (page - previousPage > 1) html += '<span class="pager-ellipsis">&hellip;</span>';
    html += `<button type="button" class="pager-page${page === currentPage ? " active" : ""}" data-page="${page}">${page}</button>`;
    previousPage = page;
  });
  html += `<button type="button" class="pager-arrow" data-page="${currentPage + 1}"${currentPage >= totalPages ? " disabled" : ""} aria-label="Next page">&rarr;</button>`;
  pagerPages.innerHTML = html;
}

function syncTableSortFromForm() {
  tableSortKey = SORT_FIELD_MAP[sortSelect.value] || "volume";
  tableSortDirection = sortDirectionSelect.value === "asc" ? "asc" : "desc";
}

function syncFormFromTableSort() {
  const formKey = Object.keys(SORT_FIELD_MAP).find((key) => SORT_FIELD_MAP[key] === tableSortKey);
  if (formKey) sortSelect.value = formKey;
  sortDirectionSelect.value = tableSortDirection;
}

function renderTable() {
  const rows = sortedRows();
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  updateSortButtons();
  renderPager(rows.length);

  if (!rows.length) {
    screenerRows.innerHTML = '<tr><td colspan="26" class="loading">No stocks matched the current search.</td></tr>';
    return;
  }

  screenerRows.innerHTML = pageRows.map((row, index) => {
    const changeClass = Number.isFinite(row.todayChangePercent)
      ? (row.todayChangePercent >= 0 ? "positive" : "negative")
      : "neutral";
    const rowNumber = (currentPage - 1) * pageSize + index + 1;
    return `
      <tr>
        <td data-col="no" class="row-number">${rowNumber}</td>
        <td data-col="ticker" class="symbol"><a class="signal-link" href="/chart.html?symbol=${encodeURIComponent(row.symbol)}">${escapeHtml(row.symbol)}</a></td>
        <td data-col="company">${escapeHtml(row.name || "--")}</td>
        <td data-col="sector">${escapeHtml(row.sector || "--")}</td>
        <td data-col="industry">${escapeHtml(row.industry || "--")}</td>
        <td data-col="country">${escapeHtml(row.country || "--")}</td>
        <td data-col="exchange">${escapeHtml(row.exchange || "--")}</td>
        <td data-col="marketCap">${formatMarketCap(row.marketCap)}</td>
        <td data-col="pe">${formatRatio(row.trailingPE)}</td>
        <td data-col="dividendYield">${formatDividendYield(row.dividendYield)}</td>
        <td data-col="shortFloat">${formatShortFloat(row.shortPercentFloat)}</td>
        <td data-col="analystRecom">${formatAnalystRecom(row)}</td>
        <td data-col="targetPrice">${formatMoney(row.targetMeanPrice)}</td>
        <td data-col="sharesOutstanding">${formatShares(row.sharesOutstanding)}</td>
        <td data-col="float">${formatShares(row.floatShares)}</td>
        <td data-col="price">${formatMoney(row.price)}</td>
        <td data-col="change"><span class="change ${changeClass}">${formatPercent(row.todayChangePercent)}</span></td>
        <td data-col="volume">${formatVolume(row.volume)}</td>
        <td data-col="avgVolume">${formatVolume(row.avgVolume)}</td>
        <td data-col="relativeVolume">${formatRelativeVolume(row.relativeVolume)}</td>
        <td data-col="earningsDate">${formatEarningsDate(row.earningsDate)}</td>
        <td data-col="rsi" class="rsi">${Number.isFinite(row.rsi) ? row.rsi.toFixed(2) : "--"}</td>
        <td data-col="previousRsi" class="rsi">${Number.isFinite(row.previousRsi) ? row.previousRsi.toFixed(2) : "--"}</td>
        <td data-col="signal"><span class="badge ${stateClass(row.state)}">${escapeHtml(row.state || "ERROR")}</span></td>
        <td data-col="ai">${renderAiCell(row.symbol)}</td>
        <td data-col="watchlist">${renderWatchlistCell(row.symbol)}</td>
      </tr>
    `;
  }).join("");
}

let currentAccount = null;
const addedToWishlist = new Set();

function renderWatchlistCell(symbol) {
  if (currentAccount && currentAccount.role === "guest") {
    return '<span class="helper-text">Sign up</span>';
  }
  if (addedToWishlist.has(symbol)) {
    return '<span class="badge BUY_SIGNAL">Added</span>';
  }
  return `<button type="button" class="secondary-btn" data-add-wishlist="${escapeHtml(symbol)}">+ Wishlist</button>`;
}

document.addEventListener("account:ready", (event) => {
  currentAccount = event.detail;
});

function renderRows(payload) {
  currentRows = Array.isArray(payload.data) ? payload.data : [];
  currentPage = 1;
  aiPredictionResults.clear();
  const rows = currentRows;
  matchCount.textContent = rows.length;
  searchBuyCount.textContent = rows.filter((row) => row.state === "BUY SIGNAL").length;
  searchOversoldCount.textContent = rows.filter((row) => row.state === "OVERSOLD").length;
  searchUpdated.textContent = formatTime(payload.updatedAt);
  screenerHelper.textContent = `${payload.presetLabel}: ${rows.length} matches from ${payload.source}.`;
  renderTable();
}

function buildParams() {
  const params = new URLSearchParams();
  const query = screenerQuery.value.trim();
  if (query) params.set("q", query);
  params.set("preset", presetSelect.value);
  params.set("signal", signalSelect.value);
  params.set("sort", sortSelect.value);
  params.set("direction", sortDirectionSelect.value === "asc" ? "asc" : "desc");
  params.set("limit", String(SCREENER_LIMIT));
  if (minPrice.value) params.set("minPrice", minPrice.value);
  if (maxPrice.value) params.set("maxPrice", maxPrice.value);
  if (minVolume.value) params.set("minVolume", minVolume.value);
  if (minAvgVolume.value) params.set("minAvgVolume", minAvgVolume.value);
  if (minRelativeVolume.value) params.set("minRelativeVolume", minRelativeVolume.value);
  if (marketCapSelect.value) params.set("minMarketCap", marketCapSelect.value);
  if (maxPE.value) params.set("maxPE", maxPE.value);
  if (minDividendYield.value) params.set("minDividendYield", minDividendYield.value);
  if (minShortFloat.value) params.set("minShortFloat", minShortFloat.value);
  if (analystRecomSelect.value) params.set("maxAnalystRecommendation", analystRecomSelect.value);
  if (minTargetPrice.value) params.set("minTargetPrice", minTargetPrice.value);
  if (maxTargetPrice.value) params.set("maxTargetPrice", maxTargetPrice.value);
  if (sharesOutstandingSelect.value) params.set("minSharesOutstanding", sharesOutstandingSelect.value);
  if (floatSelect.value) params.set("minFloat", floatSelect.value);
  if (exchangeSelect.value) params.set("exchange", exchangeSelect.value);
  if (sectorSelect.value) params.set("sector", sectorSelect.value);
  if (industryQuery.value.trim()) params.set("industry", industryQuery.value.trim());
  if (countryQuery.value.trim()) params.set("country", countryQuery.value.trim());
  if (earningsSelect.value) params.set("earningsWithinDays", earningsSelect.value);
  return params;
}

async function loadScreener() {
  if (searchIsLoading) {
    searchPendingRefresh = true;
    return;
  }
  searchIsLoading = true;
  setSearchStatus("Searching", "live");
  try {
    const response = await fetch(`/api/screener?${buildParams().toString()}`, {
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    syncTableSortFromForm();
    renderRows(payload);
    setSearchStatus("Live", "live");
  } catch (error) {
    setSearchStatus("Error", "error");
    screenerHelper.textContent = error.message;
    currentRows = [];
    renderPager(0);
    screenerRows.innerHTML = `<tr><td colspan="26" class="loading">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    searchIsLoading = false;
    if (searchPendingRefresh) {
      searchPendingRefresh = false;
      loadScreener();
    }
  }
}

screenerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadScreener();
});

resetScreener.addEventListener("click", () => {
  screenerForm.reset();
  loadScreener();
});

const ADVANCED_FILTERS_KEY = "marketRsiDashboard.advancedFiltersOpen";

function setAdvancedFiltersOpen(open) {
  advancedFilters.hidden = !open;
  toggleAdvancedFilters.setAttribute("aria-expanded", String(open));
  toggleAdvancedFilters.innerHTML = open
    ? '<span aria-hidden="true">&#9662;</span> Hide advanced filters'
    : '<span aria-hidden="true">&#9662;</span> Show advanced filters';
  try {
    localStorage.setItem(ADVANCED_FILTERS_KEY, open ? "1" : "0");
  } catch {
    // localStorage unavailable (private mode, etc.) - state just won't persist
  }
}

toggleAdvancedFilters.addEventListener("click", () => {
  setAdvancedFiltersOpen(advancedFilters.hidden);
});

let storedAdvancedFiltersOpen = true;
try {
  storedAdvancedFiltersOpen = localStorage.getItem(ADVANCED_FILTERS_KEY) !== "0";
} catch {
  // localStorage unavailable - default to open
}
setAdvancedFiltersOpen(storedAdvancedFiltersOpen);

sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const nextKey = button.dataset.sortKey;
    if (tableSortKey === nextKey) {
      tableSortDirection = tableSortDirection === "asc" ? "desc" : "asc";
    } else {
      tableSortKey = nextKey;
      tableSortDirection = nextKey === "symbol" || nextKey === "state" ? "asc" : "desc";
    }
    syncFormFromTableSort();
    currentPage = 1;
    renderTable();
  });
});

sortSelect.addEventListener("change", () => {
  syncTableSortFromForm();
  currentPage = 1;
  renderTable();
});

sortDirectionSelect.addEventListener("change", () => {
  syncTableSortFromForm();
  currentPage = 1;
  renderTable();
});

const PRESET_DEFAULT_SORT = {
  "top-gainers": { sort: "change", direction: "desc" },
  "top-losers": { sort: "change", direction: "asc" }
};

presetSelect.addEventListener("change", () => {
  const defaults = PRESET_DEFAULT_SORT[presetSelect.value];
  if (defaults) {
    sortSelect.value = defaults.sort;
    sortDirectionSelect.value = defaults.direction;
  }
  loadScreener();
});

[
  signalSelect, minPrice, maxPrice, minVolume, minAvgVolume, minRelativeVolume,
  marketCapSelect, maxPE, minDividendYield, minShortFloat, analystRecomSelect,
  minTargetPrice, maxTargetPrice, sharesOutstandingSelect, floatSelect,
  exchangeSelect, sectorSelect, industryQuery, countryQuery, earningsSelect
].forEach((field) => {
  field.addEventListener("change", () => loadScreener());
});

screenerTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    screenerTabs.forEach((other) => {
      other.classList.toggle("active", other === tab);
      other.setAttribute("aria-selected", other === tab ? "true" : "false");
    });
    screenerTable.dataset.view = tab.dataset.view;
  });
});

pageSizeSelect.addEventListener("change", () => {
  currentPage = 1;
  renderTable();
});

pagerPages.addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (!button || button.disabled) return;
  const page = Number(button.dataset.page);
  if (!Number.isFinite(page)) return;
  currentPage = page;
  renderTable();
});

if (window.createStockSearch && symbolSuggestions) {
  symbolSearch = window.createStockSearch({
    input: screenerQuery,
    suggestions: symbolSuggestions,
    onSelect: function (item) {
      screenerQuery.value = item.symbol;
      if (symbolSearch) symbolSearch.hide();
      loadScreener();
    }
  });
}

loadScreener();
