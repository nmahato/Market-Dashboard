const rows = document.getElementById("rows");
const statusText = document.getElementById("statusText");
const connectionDot = document.getElementById("connectionDot");
const countdown = document.getElementById("countdown");
const signalCount = document.getElementById("signalCount");
const oversoldCount = document.getElementById("oversoldCount");
const extendedCount = document.getElementById("extendedCount");
const updatedAt = document.getElementById("updatedAt");
const symbolForm = document.getElementById("symbolForm");
const symbolInput = document.getElementById("symbolInput");
const symbolStatus = document.getElementById("symbolStatus");
const sortButtons = Array.from(document.querySelectorAll(".sort-btn"));

const refreshSeconds = 5;
let nextRefresh = refreshSeconds;
let latestData = null;
let sortState = { key: "symbol", direction: "asc" };

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
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function renderSparkline(values, changePercent) {
  if (!Array.isArray(values) || values.length < 2) return "";
  const width = 100;
  const height = 40;
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - minValue) / range) * (height - 8) - 4;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const strokeColor = Number.isFinite(changePercent)
    ? (changePercent >= 0 ? "#0f8a5f" : "#aa2e25")
    : "#2f5f9f";
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline points="${points}" stroke="${strokeColor}" /></svg>`;
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function compareItems(a, b) {
  const { key, direction } = sortState;
  const multiplier = direction === "asc" ? 1 : -1;
  const first = a[key];
  const second = b[key];

  if (typeof first === "number" || typeof second === "number") {
    const firstValue = Number.isFinite(first) ? first : Number.NEGATIVE_INFINITY;
    const secondValue = Number.isFinite(second) ? second : Number.NEGATIVE_INFINITY;
    return (firstValue - secondValue) * multiplier;
  }

  return String(first || "").localeCompare(String(second || ""), "en", {
    numeric: true,
    sensitivity: "base"
  }) * multiplier;
}

function updateSortHeaders() {
  sortButtons.forEach((button) => {
    const isActive = button.dataset.sort === sortState.key;
    const indicator = button.querySelector("span");
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-sort", isActive ? sortState.direction : "none");
    if (indicator) indicator.textContent = isActive ? (sortState.direction === "asc" ? "^" : "v") : "";
  });
}

function render(data) {
  latestData = data;
  const items = [...(data.data || [])].sort(compareItems);
  const trackedSymbols = Array.isArray(data.symbols) ? data.symbols : [];
  const signals = items.filter((item) => item.state === "BUY SIGNAL").length;
  const oversold = items.filter((item) => item.state === "OVERSOLD").length;
  const extended = items.filter((item) => item.state === "EXTENDED").length;

  signalCount.textContent = signals;
  oversoldCount.textContent = oversold;
  extendedCount.textContent = extended;
  updatedAt.textContent = formatTime(data.updatedAt);
  if (trackedSymbols.length) {
    symbolStatus.textContent = `Tracking ${trackedSymbols.length} symbols: ${trackedSymbols.join(", ")}`;
  } else {
    symbolStatus.textContent = "No symbols are being tracked yet.";
  }

  rows.innerHTML = items
    .map((item) => {
      const stateClass = String(item.state || "ERROR").replace(" ", "_");
      const rowClass = item.crossedBackAbove30 ? "crossover-row" : "";
      const signalLabel = item.crossedBackAbove30 ? "RSI CROSSOVER" : item.state || "ERROR";
      const changeClass = Number.isFinite(item.todayChangePercent)
        ? (item.todayChangePercent >= 0 ? "positive" : "negative")
        : "neutral";
      return `
        <tr class="${rowClass}">
          <td class="symbol">${item.symbol}</td>
          <td>${formatMoney(item.price)}</td>
          <td>${formatVolume(item.volume)}</td>
          <td>${formatVolume(item.avgVolume)}</td>
          <td><span class="change ${changeClass}">${formatPercent(item.todayChangePercent)}</span></td>
          <td>${renderSparkline(item.chart, item.todayChangePercent)}</td>
          <td class="rsi">${Number.isFinite(item.rsi) ? item.rsi.toFixed(2) : "--"}</td>
          <td class="rsi">${Number.isFinite(item.previousRsi) ? item.previousRsi.toFixed(2) : "--"}</td>
          <td><span class="badge ${stateClass}">${signalLabel}</span></td>
        </tr>
      `;
    })
    .join("");
}

sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sort;
    if (sortState.key === key) {
      sortState = { key, direction: sortState.direction === "asc" ? "desc" : "asc" };
    } else {
      sortState = { key, direction: key === "symbol" ? "asc" : "desc" };
    }
    updateSortHeaders();
    if (latestData) render(latestData);
  });
});

async function loadData() {
  statusText.textContent = "Refreshing";
  try {
    const response = await fetch("/api/market", { cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const data = await response.json();
    render(data);
    statusText.textContent = "Live";
    connectionDot.className = "dot live";
  } catch (error) {
    statusText.textContent = "Data error";
    connectionDot.className = "dot error";
    rows.innerHTML = `<tr><td colspan="9" class="loading">${error.message}</td></tr>`;
  } finally {
    nextRefresh = refreshSeconds;
  }
}

symbolForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = symbolInput.value.trim();
  if (!value) return;

  symbolStatus.textContent = "Adding symbols...";
  try {
    const response = await fetch("/api/symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: value })
    });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const result = await response.json();
    symbolInput.value = "";
    if (Array.isArray(result.symbols) && result.symbols.length) {
      symbolStatus.textContent = `Tracking ${result.symbols.length} symbols: ${result.symbols.join(", ")}`;
    } else {
      symbolStatus.textContent = "No symbols are being tracked yet.";
    }
    await loadData();
  } catch (error) {
    symbolStatus.textContent = error.message;
  }
});

setInterval(() => {
  nextRefresh -= 1;
  if (nextRefresh <= 0) {
    loadData();
  }
  countdown.textContent = `${Math.max(nextRefresh, 0)}s`;
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    nextRefresh = refreshSeconds;
    loadData();
  }
});

updateSortHeaders();
loadData();
