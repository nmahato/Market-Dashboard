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
const addTickerForm = document.getElementById("addTickerForm");
const addTickerInput = document.getElementById("addTickerInput");
const addTickerSuggestions = document.getElementById("addTickerSuggestions");
const addTickerStatus = document.getElementById("addTickerStatus");
const wishlistSwitcher = document.getElementById("wishlistSwitcher");
const wishlistSelect = document.getElementById("wishlistSelect");
const renameWishlistBtn = document.getElementById("renameWishlistBtn");
const deleteWishlistBtn = document.getElementById("deleteWishlistBtn");
const newWishlistBtn = document.getElementById("newWishlistBtn");

const refreshSeconds = 5;
let nextRefresh = refreshSeconds;
let latestData = null;
let sortState = { key: "updatedAt", direction: "desc" };
let isRefreshing = false;
let pendingRefresh = false;
let audioContext;
let showAll = false;
let isGuest = false;
let wishlists = [];
let activeWishlistId = null;
const ACTIVE_WISHLIST_KEY = "activeWishlistId";
const signalStateKey = "marketRsiDashboard.signalStates";

const GUEST_WISHLIST_KEY = "guestWishlist";

function readGuestWishlist() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GUEST_WISHLIST_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeGuestWishlist(symbols) {
  try {
    localStorage.setItem(GUEST_WISHLIST_KEY, JSON.stringify(symbols));
  } catch {
    /* localStorage unavailable (private mode, etc.) */
  }
}

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
  topStockCount.textContent = trackedSymbols.length;
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
          <td><button type="button" class="remove-ticker-btn" data-remove-symbol="${item.symbol}" title="Remove ${item.symbol} from watchlist">Remove</button></td>
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
    const url = isGuest
      ? `/api/market?symbols=${encodeURIComponent(readGuestWishlist().join(","))}`
      : showAll
        ? "/api/market?view=all"
        : `/api/market${activeWishlistId ? `?wishlistId=${activeWishlistId}` : ""}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const data = await response.json();
    if (!isGuest && data.activeWishlistId) activeWishlistId = data.activeWishlistId;
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

function renderWishlistSelect() {
  if (!wishlistSelect) return;
  wishlistSelect.innerHTML = wishlists.map((list) => `
    <option value="${list.id}" ${list.id === activeWishlistId ? "selected" : ""}>${escapeHtmlAttr(list.name)} (${list.symbolCount})</option>
  `).join("");
}

function escapeHtmlAttr(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

async function loadWishlists() {
  try {
    const response = await fetch("/api/wishlists", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    wishlists = payload.wishlists || [];
    const stored = Number(localStorage.getItem(ACTIVE_WISHLIST_KEY));
    activeWishlistId = wishlists.some((list) => list.id === stored) ? stored : (wishlists[0] ? wishlists[0].id : null);
    renderWishlistSelect();
    if (wishlistSwitcher) wishlistSwitcher.hidden = false;
  } catch (error) {
    if (addTickerStatus) addTickerStatus.textContent = error.message;
  }
  loadData();
}

if (wishlistSelect) {
  wishlistSelect.addEventListener("change", () => {
    activeWishlistId = Number(wishlistSelect.value);
    try {
      localStorage.setItem(ACTIVE_WISHLIST_KEY, String(activeWishlistId));
    } catch {
      /* localStorage unavailable */
    }
    loadData();
  });
}

if (newWishlistBtn) {
  newWishlistBtn.addEventListener("click", async () => {
    const name = window.prompt("Name your new wishlist:");
    if (!name || !name.trim()) return;
    try {
      const response = await fetch("/api/wishlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
      wishlists = payload.wishlists || [];
      activeWishlistId = wishlists[wishlists.length - 1].id;
      renderWishlistSelect();
      loadData();
    } catch (error) {
      if (addTickerStatus) addTickerStatus.textContent = error.message;
    }
  });
}

if (renameWishlistBtn) {
  renameWishlistBtn.addEventListener("click", async () => {
    const current = wishlists.find((list) => list.id === activeWishlistId);
    const name = window.prompt("Rename wishlist:", current ? current.name : "");
    if (!name || !name.trim()) return;
    try {
      const response = await fetch(`/api/wishlists/${activeWishlistId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
      wishlists = payload.wishlists || [];
      renderWishlistSelect();
    } catch (error) {
      if (addTickerStatus) addTickerStatus.textContent = error.message;
    }
  });
}

if (deleteWishlistBtn) {
  deleteWishlistBtn.addEventListener("click", async () => {
    const current = wishlists.find((list) => list.id === activeWishlistId);
    if (!current) return;
    if (!window.confirm(`Delete wishlist "${current.name}" and its symbols? This can't be undone.`)) return;
    try {
      const response = await fetch(`/api/wishlists/${activeWishlistId}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
      wishlists = payload.wishlists || [];
      activeWishlistId = wishlists[0] ? wishlists[0].id : null;
      renderWishlistSelect();
      loadData();
    } catch (error) {
      if (addTickerStatus) addTickerStatus.textContent = error.message;
    }
  });
}

document.addEventListener("account:ready", (event) => {
  const user = event.detail;
  isGuest = Boolean(user && user.role === "guest");
  if (addTickerStatus && isGuest) {
    addTickerStatus.textContent = "Guest mode: your wishlist is saved only in this browser.";
  }
  if (isGuest) {
    loadData();
  } else {
    loadWishlists();
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

if (window.createStockSearch && addTickerInput && addTickerSuggestions) {
  window.createStockSearch({
    input: addTickerInput,
    suggestions: addTickerSuggestions,
    onSelect: () => addTickerInput.focus()
  });
}

async function addTicker(symbol) {
  addTickerStatus.textContent = `Adding ${symbol}...`;
  if (isGuest) {
    const list = readGuestWishlist();
    if (!list.includes(symbol)) list.push(symbol);
    writeGuestWishlist(list);
    addTickerInput.value = "";
    addTickerStatus.textContent = `Added ${symbol} to your guest wishlist (saved in this browser only).`;
    loadData();
    return;
  }
  try {
    const response = await fetch("/api/watchlist/symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: symbol, wishlistId: activeWishlistId })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    addTickerInput.value = "";
    addTickerStatus.textContent = `Added ${symbol} to your watchlist.`;
    loadData();
  } catch (error) {
    addTickerStatus.textContent = error.message;
  }
}

async function removeTicker(symbol) {
  if (!window.confirm(`Remove ${symbol} from your watchlist?`)) return;
  addTickerStatus.textContent = `Removing ${symbol}...`;
  if (isGuest) {
    writeGuestWishlist(readGuestWishlist().filter((item) => item !== symbol));
    addTickerStatus.textContent = `Removed ${symbol} from your guest wishlist.`;
    loadData();
    return;
  }
  try {
    const response = await fetch("/api/watchlist/symbols", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: symbol, wishlistId: activeWishlistId })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    addTickerStatus.textContent = `Removed ${symbol} from your watchlist.`;
    loadData();
  } catch (error) {
    addTickerStatus.textContent = error.message;
  }
}

if (addTickerForm) {
  addTickerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const symbol = addTickerInput.value.trim().toUpperCase();
    if (!symbol) return;
    addTicker(symbol);
  });
}

rows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-symbol]");
  if (!button) return;
  removeTicker(button.dataset.removeSymbol);
});

updateSortHeaders();
loadData();
