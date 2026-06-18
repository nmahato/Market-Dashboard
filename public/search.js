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

let symbolSearch;
let isLoading = false;

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

function renderRows(payload) {
  const rows = Array.isArray(payload.data) ? payload.data : [];
  matchCount.textContent = rows.length;
  searchBuyCount.textContent = rows.filter((row) => row.state === "BUY SIGNAL").length;
  searchOversoldCount.textContent = rows.filter((row) => row.state === "OVERSOLD").length;
  searchUpdated.textContent = formatTime(payload.updatedAt);
  screenerHelper.textContent = `${payload.presetLabel}: ${rows.length} matches from ${payload.source}.`;

  if (!rows.length) {
    screenerRows.innerHTML = '<tr><td colspan="9" class="loading">No stocks matched the current search.</td></tr>';
    return;
  }

  screenerRows.innerHTML = rows.map((row) => {
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
    renderRows(payload);
    setStatus("Live", "live");
  } catch (error) {
    setStatus("Error", "error");
    screenerHelper.textContent = error.message;
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
