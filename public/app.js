const rows = document.getElementById("rows");
const statusText = document.getElementById("statusText");
const connectionDot = document.getElementById("connectionDot");
const countdown = document.getElementById("countdown");
const buySignalCount = document.getElementById("buySignalCount");
const sellSignalCount = document.getElementById("sellSignalCount");
const oversoldCount = document.getElementById("oversoldCount");
const extendedCount = document.getElementById("extendedCount");
const topStockCount = document.getElementById("topStockCount");
const updatedAt = document.getElementById("updatedAt");
const symbolForm = document.getElementById("symbolForm");
const symbolStatus = document.getElementById("symbolStatus");
const showAllToggle = document.getElementById("showAllToggle");
const showAllCheckbox = document.getElementById("showAllCheckbox");
const sortButtons = Array.from(document.querySelectorAll(".sort-btn"));
const signalAlert = document.getElementById("signalAlert");
const signalAlertClose = document.getElementById("signalAlertClose");
const signalAlertDismiss = document.getElementById("signalAlertDismiss");
const signalAlertType = document.getElementById("signalAlertType");
const signalAlertTitle = document.getElementById("signalAlertTitle");
const signalAlertList = document.getElementById("signalAlertList");

const refreshSeconds = 5;
let nextRefresh = refreshSeconds;
let latestData = null;
let sortState = { key: "updatedAt", direction: "desc" };
let isRefreshing = false;
let pendingRefresh = false;
let audioContext;
let showAll = false;
const signalStateKey = "marketRsiDashboard.signalStates";

function readSignalStates() {
  try {
    return JSON.parse(localStorage.getItem(signalStateKey)) || {};
  } catch {
    return {};
  }
}

let previousSignalStates = readSignalStates();

function armAlertSound() {
  if (!audioContext) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) audioContext = new AudioContext();
  }
  if (audioContext && audioContext.state === "suspended") audioContext.resume().catch(() => {});
}

function playAlertSound(side) {
  armAlertSound();
  if (!audioContext || audioContext.state !== "running") return;

  const start = audioContext.currentTime;
  const notes = side === "buy" ? [523.25, 659.25, 783.99] : [783.99, 659.25, 523.25];
  notes.forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const noteStart = start + index * 0.14;
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.18, noteStart + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.12);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + 0.13);
  });
}

function closeSignalAlert() {
  signalAlert.hidden = true;
}

function showSignalAlert(signals) {
  if (!signals.length) return;
  const hasBuy = signals.some((item) => item.state === "BUY SIGNAL");
  const hasSell = signals.some((item) => item.state === "SELL SIGNAL");
  const side = hasBuy && !hasSell ? "buy" : hasSell && !hasBuy ? "sell" : "mixed";

  signalAlert.className = `signal-alert ${side}`;
  signalAlertType.textContent = side === "mixed" ? "BUY & SELL" : side.toUpperCase();
  signalAlertTitle.textContent = signals.length === 1
    ? `${signals[0].state}: ${signals[0].symbol}`
    : `${signals.length} new trading signals`;
  signalAlertList.replaceChildren(...signals.map((item) => {
    const row = document.createElement("div");
    const name = document.createElement("strong");
    const details = document.createElement("span");
    name.textContent = `${item.symbol} — ${item.state}`;
    details.textContent = `RSI ${Number.isFinite(item.rsi) ? item.rsi.toFixed(2) : "--"} · Price ${formatMoney(item.price)}`;
    row.append(name, details);
    return row;
  }));
  signalAlert.hidden = false;
  signalAlertDismiss.focus();
  playAlertSound(side === "mixed" ? "buy" : side);
}

function alertForNewSignals(items) {
  const newStates = {};
  const signals = [];

  items.forEach((item) => {
    newStates[item.symbol] = item.state;
    const isSignal = item.state === "BUY SIGNAL" || item.state === "SELL SIGNAL";
    if (isSignal && previousSignalStates[item.symbol] !== item.state) signals.push(item);
  });

  previousSignalStates = newStates;
  try {
    localStorage.setItem(signalStateKey, JSON.stringify(newStates));
  } catch {
    // Alerts still work for this page session if storage is unavailable.
  }
  showSignalAlert(signals);
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
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><polyline points="${points}" style="stroke: ${strokeColor}" /></svg>`;
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
  const first = getSortValue(a, key);
  const second = getSortValue(b, key);

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

function getSortValue(item, key) {
  if (key === "updatedAt") {
    const timestamp = Date.parse(item.updatedAt);
    return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
  }

  if (key === "chartLast") {
    const values = Array.isArray(item.chart) ? item.chart : [];
    return values.length ? values[values.length - 1] : Number.NEGATIVE_INFINITY;
  }

  return item[key];
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
  const topStocks = data.topStocks && Array.isArray(data.topStocks.symbols) ? data.topStocks : null;
  const buySignals = items.filter((item) => item.state === "BUY SIGNAL").length;
  const sellSignals = items.filter((item) => item.state === "SELL SIGNAL").length;
  const oversold = items.filter((item) => item.state === "OVERSOLD").length;
  const extended = items.filter((item) => item.state === "EXTENDED").length;

  alertForNewSignals(items);

  buySignalCount.textContent = buySignals;
  sellSignalCount.textContent = sellSignals;
  oversoldCount.textContent = oversold;
  extendedCount.textContent = extended;
  topStockCount.textContent = topStocks ? topStocks.symbols.length : 0;
  updatedAt.textContent = formatTime(data.updatedAt);
  if (trackedSymbols.length) {
    const source = topStocks ? topStocks.source : "watchlist";
    const topText="";
    // const topText = data.viewingAll
    //   ? `Showing the full daily list: ${trackedSymbols.length} stocks`
    //   : `Tracking ${trackedSymbols.length} Admin-selected stocks: ${trackedSymbols.join(", ")}`;
    const errorText = topStocks && topStocks.error ? ` Top list fallback: ${topStocks.error}.` : "";
    // symbolStatus.textContent = `${topText}. Source: ${source}.${errorText}`;
  } else {
    symbolStatus.textContent = "No symbols are being tracked yet.";
  }

  rows.innerHTML = items
    .map((item) => {
      const stateClass = String(item.state || "ERROR").replace(" ", "_");
      const rowClass = item.crossedBackAbove30
        ? "buy-signal-row"
        : item.crossedBackBelow70
          ? "sell-signal-row"
          : "";
      const signalLabel = item.crossedBackAbove30
        ? "BUY RSI CROSS"
        : item.crossedBackBelow70
          ? "SELL RSI CROSS"
          : item.state || "ERROR";
      const changeClass = Number.isFinite(item.todayChangePercent)
        ? (item.todayChangePercent >= 0 ? "positive" : "negative")
        : "neutral";
      return `
        <tr class="${rowClass}">
          <!-- <td>${formatTime(item.updatedAt)}</td> -->
          <td class="symbol">${item.symbol}</td>
          <td>${formatMoney(item.price)}</td>
          <td>${formatVolume(item.volume)}</td>
          <td>${formatVolume(item.avgVolume)}</td>
          <td><span class="change ${changeClass}">${formatPercent(item.todayChangePercent)}</span></td>
          <td>${renderSparkline(item.chart, item.todayChangePercent)}</td>
          <td class="rsi">${Number.isFinite(item.rsi) ? item.rsi.toFixed(2) : "--"}</td>
          <td class="rsi">${Number.isFinite(item.previousRsi) ? item.previousRsi.toFixed(2) : "--"}</td>
          <td><a class="badge signal-link ${stateClass}" href="/chart.html?symbol=${encodeURIComponent(item.symbol)}&live=1">${signalLabel}</a></td>
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
      sortState = { key, direction: key === "symbol" || key === "state" ? "asc" : "desc" };
    }
    updateSortHeaders();
    if (latestData) render(latestData);
  });
});

async function loadData() {
  if (isRefreshing) {
    pendingRefresh = true;
    return;
  }

  isRefreshing = true;
  statusText.textContent = "Refreshing";
  countdown.textContent = "now";
  try {
    const url = showAll ? "/api/market?view=all" : "/api/market";
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const data = await response.json();
    render(data);
    statusText.textContent = "Live";
    connectionDot.className = "dot live";
  } catch (error) {
    statusText.textContent = "Data error";
    connectionDot.className = "dot error";
    rows.innerHTML = `<tr><td colspan="10" class="loading">${error.message}</td></tr>`;
  } finally {
    isRefreshing = false;
    nextRefresh = refreshSeconds;
    countdown.textContent = `${nextRefresh}s`;
    if (pendingRefresh) {
      pendingRefresh = false;
      loadData();
    }
  }
}

signalAlertClose.addEventListener("click", closeSignalAlert);
signalAlertDismiss.addEventListener("click", closeSignalAlert);
signalAlert.addEventListener("click", (event) => {
  if (event.target === signalAlert) closeSignalAlert();
});
document.addEventListener("keydown", (event) => {
  armAlertSound();
  if (event.key === "Escape" && !signalAlert.hidden) closeSignalAlert();
}, { once: false });
document.addEventListener("pointerdown", armAlertSound, { once: true });

setInterval(() => {
  nextRefresh -= 1;
  if (nextRefresh <= 0 && !isRefreshing) {
    loadData();
  }
  countdown.textContent = isRefreshing ? "now" : `${Math.max(nextRefresh, 0)}s`;
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    nextRefresh = refreshSeconds;
    loadData();
  }
});

if (showAllToggle && showAllCheckbox) {
  document.addEventListener("account:ready", (event) => {
    const user = event.detail;
    if (user && user.role === "admin") {
      showAllToggle.hidden = false;
    } else {
      showAllToggle.hidden = true;
      showAll = false;
      showAllCheckbox.checked = false;
    }
  });

  showAllCheckbox.addEventListener("change", () => {
    showAll = showAllCheckbox.checked;
    loadData();
  });
}

updateSortHeaders();
loadData();
