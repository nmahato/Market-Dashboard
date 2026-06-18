const screenerForm = document.getElementById("screenerForm");
const screenerQuery = document.getElementById("screenerQuery");
const presetSelect = document.getElementById("presetSelect");
const signalSelect = document.getElementById("signalSelect");
const minPrice = document.getElementById("minPrice");
const maxPrice = document.getElementById("maxPrice");
const minVolume = document.getElementById("minVolume");
const sortSelect = document.getElementById("sortSelect");
const resetScreener = document.getElementById("resetScreener");
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
const pageSizeSelect = document.getElementById("pageSizeSelect");
const pagerInfo = document.getElementById("pagerInfo");
const prevPage = document.getElementById("prevPage");
const nextPage = document.getElementById("nextPage");
const pageNumber = document.getElementById("pageNumber");

let symbolSearch;
let isLoading = false;
let currentRows = [];
let tableSortKey = "volume";
let tableSortDirection = "desc";
let currentPage = 1;

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

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function stateClass(value) {
  return String(value || "ERROR").replace(" ", "_");
}

function setStatus(text, state) {
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

function compareRows(firstRow, secondRow) {
  const first = sortValue(firstRow, tableSortKey);
  const second = sortValue(secondRow, tableSortKey);
  const emptyFirst = first === null || first === undefined || first === "";
  const emptySecond = second === null || second === undefined || second === "";

  if (emptyFirst && emptySecond) return 0;
  if (emptyFirst) return 1;
  if (emptySecond) return -1;

  if (typeof first === "string" || typeof second === "string") {
    return String(first).localeCompare(String(second));
  }

  return first - second;
}

function sortedRows() {
  const direction = tableSortDirection === "asc" ? 1 : -1;
  return [...currentRows].sort((firstRow, secondRow) => compareRows(firstRow, secondRow) * direction);
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

function updatePager(totalRows) {
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  currentPage = Math.min(Math.max(currentPage, 1), totalPages);
  const start = totalRows ? ((currentPage - 1) * pageSize) + 1 : 0;
  const end = Math.min(currentPage * pageSize, totalRows);

  pagerInfo.textContent = totalRows ? `Showing ${start}-${end} of ${totalRows}` : "0 results";
  pageNumber.textContent = `Page ${currentPage} of ${totalPages}`;
  prevPage.disabled = currentPage <= 1;
  nextPage.disabled = currentPage >= totalPages;
}

function syncTableSortFromForm() {
  const sortMap = {
    volume: "volume",
    change: "todayChangePercent",
    price: "price",
    rsi: "rsi",
    symbol: "symbol",
    signal: "state"
  };
  tableSortKey = sortMap[sortSelect.value] || "volume";
  tableSortDirection = tableSortKey === "symbol" || tableSortKey === "state" ? "asc" : "desc";
}

function renderTable() {
  const rows = sortedRows();
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  updateSortButtons();
  updatePager(rows.length);

  if (!rows.length) {
    screenerRows.innerHTML = '<tr><td colspan="9" class="loading">No stocks matched the current search.</td></tr>';
    return;
  }

  screenerRows.innerHTML = pageRows.map((row) => {
    const changeClass = Number.isFinite(row.todayChangePercent)
      ? (row.todayChangePercent >= 0 ? "positive" : "negative")
      : "neutral";
    return `
      <tr>
        <td class="symbol">${escapeHtml(row.symbol)}</td>
        <td>${formatMoney(row.price)}</td>
        <td><span class="change ${changeClass}">${formatPercent(row.todayChangePercent)}</span></td>
        <td>${formatVolume(row.volume)}</td>
        <td>${formatVolume(row.avgVolume)}</td>
        <td class="rsi">${Number.isFinite(row.rsi) ? row.rsi.toFixed(2) : "--"}</td>
        <td class="rsi">${Number.isFinite(row.previousRsi) ? row.previousRsi.toFixed(2) : "--"}</td>
        <td><span class="badge ${stateClass(row.state)}">${escapeHtml(row.state || "ERROR")}</span></td>
        <td class="action-links">
          <a href="/indicator.html?symbol=${encodeURIComponent(row.symbol)}">Signals</a>
          <a href="/news.html?q=${encodeURIComponent(row.symbol)}">News</a>
        </td>
      </tr>
    `;
  }).join("");
}

function renderRows(payload) {
  currentRows = Array.isArray(payload.data) ? payload.data : [];
  currentPage = 1;
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
  if (minPrice.value) params.set("minPrice", minPrice.value);
  if (maxPrice.value) params.set("maxPrice", maxPrice.value);
  if (minVolume.value) params.set("minVolume", minVolume.value);
  return params;
}

async function loadScreener() {
  if (isLoading) return;
  isLoading = true;
  setStatus("Searching", "live");
  try {
    const response = await fetch(`/api/screener?${buildParams().toString()}`, {
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    syncTableSortFromForm();
    renderRows(payload);
    setStatus("Live", "live");
  } catch (error) {
    setStatus("Error", "error");
    screenerHelper.textContent = error.message;
    currentRows = [];
    updatePager(0);
    screenerRows.innerHTML = `<tr><td colspan="9" class="loading">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    isLoading = false;
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

sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const nextKey = button.dataset.sortKey;
    if (tableSortKey === nextKey) {
      tableSortDirection = tableSortDirection === "asc" ? "desc" : "asc";
    } else {
      tableSortKey = nextKey;
      tableSortDirection = nextKey === "symbol" || nextKey === "state" ? "asc" : "desc";
    }
    currentPage = 1;
    renderTable();
  });
});

pageSizeSelect.addEventListener("change", () => {
  currentPage = 1;
  renderTable();
});

prevPage.addEventListener("click", () => {
  currentPage -= 1;
  renderTable();
});

nextPage.addEventListener("click", () => {
  currentPage += 1;
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
