const candleInput = document.getElementById("candleInput");
const indicatorForm = document.getElementById("indicatorForm");
const indicatorRows = document.getElementById("indicatorRows");
const indicatorStatus = document.getElementById("indicatorStatus");
const rowCount = document.getElementById("rowCount");
const buyCount = document.getElementById("buyCount");
const sellCount = document.getElementById("sellCount");
const loadSample = document.getElementById("loadSample");
const exportJson = document.getElementById("exportJson");
const symbolInput = document.getElementById("symbolInput");
const intervalSelect = document.getElementById("intervalSelect");
const fetchLive = document.getElementById("fetchLive");
const autoRefresh = document.getElementById("autoRefresh");
const indicatorChart = document.getElementById("indicatorChart");
const chartRange = document.getElementById("chartRange");
const symbolSuggestions = document.getElementById("symbolSuggestions");
const chartPanel = document.querySelector(".chart-panel");
const chartStyle = document.getElementById("chartStyle");
const expandChart = document.getElementById("expandChart");
const resetChart = document.getElementById("resetChart");

let latestResults = [];
let liveRefreshTimer = null;
let isLoadingLive = false;
const liveRefreshMs = 60000;
const queryParams = new URLSearchParams(window.location.search);
let symbolSearch;
let selectedSymbolName = "";

const sampleCandles = [
  { time: "09:30", open: 100.1, high: 100.7, low: 99.9, close: 100.5, volume: 48000 },
  { time: "09:35", open: 100.5, high: 101.2, low: 100.4, close: 101, volume: 52500 },
  { time: "09:40", open: 101, high: 101.4, low: 100.6, close: 100.8, volume: 41000 },
  { time: "09:45", open: 100.8, high: 101.8, low: 100.7, close: 101.6, volume: 69000 },
  { time: "09:50", open: 101.6, high: 102.2, low: 101.2, close: 102, volume: 73000 },
  { time: "09:55", open: 102, high: 102.1, low: 101.1, close: 101.2, volume: 38000 },
  { time: "10:00", open: 101.2, high: 101.5, low: 100.3, close: 100.4, volume: 76000 },
  { time: "10:05", open: 100.4, high: 100.6, low: 99.8, close: 99.9, volume: 82000 },
  { time: "10:10", open: 99.9, high: 100.8, low: 99.7, close: 100.7, volume: 91000 },
  { time: "10:15", open: 100.7, high: 101.9, low: 100.6, close: 101.8, volume: 105000 }
];

class TradingIndicatorService {
  calculate(candles) {
    const results = [];
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    const ema9Values = this.calculateEMA(candles.map((item) => item.close), 9);
    const ema21Values = this.calculateEMA(candles.map((item) => item.close), 21);

    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i];
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativePV += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;

      const vwap = cumulativeVolume ? cumulativePV / cumulativeVolume : 0;
      const ema9 = ema9Values[i];
      const ema21 = ema21Values[i];
      const avgVolume = this.averageVolume(candles, i, 20);
      const buySignal = candle.close > vwap &&
        ema9 > ema21 &&
        candle.volume > avgVolume &&
        candle.close > candle.open;
      const sellSignal = candle.close < vwap &&
        ema9 < ema21 &&
        candle.volume > avgVolume &&
        candle.close < candle.open;

      let entryPrice;
      let tp1;
      let tp2;
      let stopLoss;

      if (buySignal) {
        entryPrice = candle.close;
        tp1 = entryPrice * 1.01;
        tp2 = entryPrice * 1.02;
        stopLoss = entryPrice * 0.995;
      }

      if (sellSignal) {
        entryPrice = candle.close;
        tp1 = entryPrice * 0.99;
        tp2 = entryPrice * 0.98;
        stopLoss = entryPrice * 1.005;
      }

      results.push({
        ...candle,
        vwap,
        ema9,
        ema21,
        buySignal,
        sellSignal,
        entryPrice,
        tp1,
        tp2,
        stopLoss
      });
    }

    return results;
  }

  calculateEMA(values, period) {
    const ema = [];
    const multiplier = 2 / (period + 1);
    values.forEach((price, index) => {
      if (index === 0) {
        ema.push(price);
      } else {
        ema.push((price - ema[index - 1]) * multiplier + ema[index - 1]);
      }
    });
    return ema;
  }

  averageVolume(candles, index, period) {
    const start = Math.max(0, index - period + 1);
    const slice = candles.slice(start, index + 1);
    return slice.reduce((sum, candle) => sum + candle.volume, 0) / slice.length;
  }
}

function parseNumber(value, field, rowNumber) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Row ${rowNumber}: ${field} must be a number`);
  }
  return number;
}

function normalizeCandle(item, rowNumber) {
  if (!item || typeof item !== "object") {
    throw new Error(`Row ${rowNumber}: candle must be an object`);
  }
  return {
    time: String(item.time || ""),
    open: parseNumber(item.open, "open", rowNumber),
    high: parseNumber(item.high, "high", rowNumber),
    low: parseNumber(item.low, "low", rowNumber),
    close: parseNumber(item.close, "close", rowNumber),
    volume: parseNumber(item.volume, "volume", rowNumber)
  };
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = lines.shift().split(",").map((header) => header.trim().toLowerCase());
  const required = ["time", "open", "high", "low", "close", "volume"];
  required.forEach((field) => {
    if (!headers.includes(field)) throw new Error(`CSV is missing ${field}`);
  });

  return lines.map((line, index) => {
    const values = line.split(",").map((value) => value.trim());
    const row = {};
    headers.forEach((header, headerIndex) => {
      row[header] = values[headerIndex];
    });
    return normalizeCandle(row, index + 2);
  });
}

function parseCandles(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste candle JSON or CSV first");

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    const candles = Array.isArray(parsed) ? parsed : parsed.candles;
    if (!Array.isArray(candles)) throw new Error("JSON must be an array or an object with a candles array");
    return candles.map((item, index) => normalizeCandle(item, index + 1));
  }

  return parseCsv(trimmed);
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function formatTime(value) {
  if (!value) return "--";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(parsed);
}

function signalLabel(result) {
  if (result.buySignal) return '<span class="badge BUY_SIGNAL">BUY</span>';
  if (result.sellSignal) return '<span class="badge ERROR">SELL</span>';
  return '<span class="badge WATCH">WATCH</span>';
}

function pointsFor(values, xForIndex, yForValue) {
  return values
    .map((value, index) => Number.isFinite(value) ? `${xForIndex(index).toFixed(2)},${yForValue(value).toFixed(2)}` : "")
    .filter(Boolean)
    .join(" ");
}

function lineLabel(label, value, x, y, className) {
  if (!Number.isFinite(value)) return "";
  return `
    <text class="line-label ${className}" x="${x.toFixed(2)}" y="${y.toFixed(2)}">${escapeHtml(label)}</text>
  `;
}

function renderSignalChart(results) {
  if (!Array.isArray(results) || results.length < 2) {
    indicatorChart.innerHTML = "<p>No candle data calculated yet.</p>";
    chartRange.textContent = "No chart data yet.";
    return;
  }

  const width = 1040;
  const height = 420;
  const padding = { top: 24, right: 72, bottom: 42, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const priceValues = results.flatMap((item) => [item.high, item.low, item.vwap, item.ema9, item.ema21])
    .filter(Number.isFinite);
  const minPrice = Math.min(...priceValues);
  const maxPrice = Math.max(...priceValues);
  const priceRange = maxPrice - minPrice || 1;
  const paddedMin = minPrice - priceRange * 0.08;
  const paddedMax = maxPrice + priceRange * 0.08;
  const paddedRange = paddedMax - paddedMin || 1;
  const candleStep = plotWidth / Math.max(results.length - 1, 1);
  const candleBodyWidth = Math.max(3, Math.min(10, candleStep * 0.56));

  const xForIndex = (index) => padding.left + (index / (results.length - 1)) * plotWidth;
  const yForValue = (value) => padding.top + ((paddedMax - value) / paddedRange) * plotHeight;
  const priceTicks = Array.from({ length: 5 }, (_, index) => paddedMin + (paddedRange / 4) * index).reverse();
  const closePoints = pointsFor(results.map((item) => item.close), xForIndex, yForValue);
  const vwapPoints = pointsFor(results.map((item) => item.vwap), xForIndex, yForValue);
  const ema9Points = pointsFor(results.map((item) => item.ema9), xForIndex, yForValue);
  const ema21Points = pointsFor(results.map((item) => item.ema21), xForIndex, yForValue);
  const mode = chartStyle ? chartStyle.value : "candles";
  const showCandles = mode === "candles" || mode === "both";
  const showCloseLine = mode === "line" || mode === "both";
  const lastIndex = results.length - 1;
  const labelX = Math.min(width - padding.right + 8, xForIndex(lastIndex) + 10);
  const labelData = [
    ["Close", results[lastIndex].close, "price-label"],
    ["VWAP", results[lastIndex].vwap, "vwap-label"],
    ["EMA9", results[lastIndex].ema9, "ema9-label"],
    ["EMA21", results[lastIndex].ema21, "ema21-label"]
  ];

  const candleMarkup = results.map((item, index) => {
    const x = xForIndex(index);
    const highY = yForValue(item.high);
    const lowY = yForValue(item.low);
    const openY = yForValue(item.open);
    const closeY = yForValue(item.close);
    const bodyY = Math.min(openY, closeY);
    const bodyHeight = Math.max(Math.abs(closeY - openY), 2);
    const directionClass = item.close >= item.open ? "up" : "down";
    return `
      <line class="candle-wick ${directionClass}" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${highY.toFixed(2)}" y2="${lowY.toFixed(2)}"></line>
      <rect class="candle-body ${directionClass}" x="${(x - candleBodyWidth / 2).toFixed(2)}" y="${bodyY.toFixed(2)}" width="${candleBodyWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}" rx="1"></rect>
    `;
  }).join("");

  const markerMarkup = results.map((item, index) => {
    if (!item.buySignal && !item.sellSignal) return "";
    const x = xForIndex(index);
    const y = yForValue(item.close);
    const markerClass = item.buySignal ? "buy-marker" : "sell-marker";
    const label = item.buySignal ? "B" : "S";
    const markerY = item.buySignal ? y - 18 : y + 24;
    return `
      <circle class="${markerClass}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5"></circle>
      <text class="${markerClass}" x="${x.toFixed(2)}" y="${markerY.toFixed(2)}" text-anchor="middle">${label}</text>
    `;
  }).join("");

  const gridMarkup = priceTicks.map((tick) => {
    const y = yForValue(tick);
    return `
      <line class="chart-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y.toFixed(2)}" y2="${y.toFixed(2)}"></line>
      <text class="chart-axis" x="${width - padding.right + 10}" y="${(y + 4).toFixed(2)}">${formatNumber(tick)}</text>
    `;
  }).join("");

  const firstTime = formatTime(results[0].time);
  const lastTime = formatTime(results[results.length - 1].time);
  const lineLabels = labelData.map(([label, value, className], index) => {
    const y = yForValue(value) + (index - 1.5) * 10;
    return lineLabel(label, value, labelX, y, className);
  }).join("");

  chartRange.textContent = `${results.length} candles from ${firstTime} to ${lastTime}.`;
  indicatorChart.innerHTML = `
    <svg class="signal-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Candlestick chart with VWAP and EMA overlays">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      ${gridMarkup}
      <text class="chart-axis" x="${padding.left}" y="${height - 12}">${escapeHtml(firstTime)}</text>
      <text class="chart-axis" x="${width - padding.right}" y="${height - 12}" text-anchor="end">${escapeHtml(lastTime)}</text>
      ${showCandles ? candleMarkup : ""}
      ${showCloseLine ? `<polyline class="price-line" points="${closePoints}"></polyline>` : ""}
      <polyline class="vwap-line" points="${vwapPoints}"></polyline>
      <polyline class="ema9-line" points="${ema9Points}"></polyline>
      <polyline class="ema21-line" points="${ema21Points}"></polyline>
      ${lineLabels}
      ${markerMarkup}
    </svg>
  `;
}

function renderResults(results) {
  latestResults = results;
  const tableResults = [...results].sort((a, b) => {
    const first = Date.parse(a.time);
    const second = Date.parse(b.time);
    return (Number.isFinite(second) ? second : 0) - (Number.isFinite(first) ? first : 0);
  });
  rowCount.textContent = results.length;
  buyCount.textContent = results.filter((result) => result.buySignal).length;
  sellCount.textContent = results.filter((result) => result.sellSignal).length;
  exportJson.disabled = !results.length;
  renderSignalChart(results);

  if (!results.length) {
    indicatorRows.innerHTML = '<tr><td colspan="14" class="loading">No candle data calculated yet.</td></tr>';
    return;
  }

  indicatorRows.innerHTML = tableResults.map((result) => `
    <tr class="${result.buySignal ? "crossover-row" : ""}">
      <td>${escapeHtml(formatTime(result.time))}</td>
      <td>${formatNumber(result.open)}</td>
      <td>${formatNumber(result.high)}</td>
      <td>${formatNumber(result.low)}</td>
      <td>${formatNumber(result.close)}</td>
      <td>${formatNumber(result.volume, 0)}</td>
      <td>${formatNumber(result.vwap)}</td>
      <td>${formatNumber(result.ema9)}</td>
      <td>${formatNumber(result.ema21)}</td>
      <td>${signalLabel(result)}</td>
      <td>${formatNumber(result.entryPrice)}</td>
      <td>${formatNumber(result.tp1)}</td>
      <td>${formatNumber(result.tp2)}</td>
      <td>${formatNumber(result.stopLoss)}</td>
    </tr>
  `).join("");
}

async function fetchLiveCandles() {
  if (isLoadingLive) return;
  let symbol = symbolInput.value.trim().toUpperCase();
  const interval = intervalSelect.value;
  if (!symbol) {
    indicatorStatus.textContent = "Enter a symbol first.";
    return;
  }

  isLoadingLive = true;
  fetchLive.disabled = true;
  indicatorStatus.textContent = `Loading live ${interval} candles for ${symbol}...`;
  try {
    if (window.resolveStockSymbol) {
      symbol = await window.resolveStockSymbol(symbol);
      symbolInput.value = symbol;
    }
    const response = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`, {
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);

    candleInput.value = JSON.stringify(payload.candles, null, 2);
    const service = new TradingIndicatorService();
    renderResults(service.calculate(payload.candles));
    indicatorStatus.textContent = `Live ${payload.symbol} ${payload.interval}: ${payload.candles.length} candles, updated ${formatTime(payload.updatedAt)}.`;
  } catch (error) {
    indicatorStatus.textContent = error.message;
  } finally {
    isLoadingLive = false;
    fetchLive.disabled = false;
  }
}

function updateLiveRefresh() {
  if (liveRefreshTimer) {
    clearInterval(liveRefreshTimer);
    liveRefreshTimer = null;
  }

  if (autoRefresh.checked) {
    fetchLiveCandles();
    liveRefreshTimer = setInterval(fetchLiveCandles, liveRefreshMs);
  }
}

indicatorForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const candles = parseCandles(candleInput.value);
    const service = new TradingIndicatorService();
    renderResults(service.calculate(candles));
    indicatorStatus.textContent = `Calculated ${candles.length} candles.`;
  } catch (error) {
    indicatorStatus.textContent = error.message;
    renderResults([]);
  }
});

fetchLive.addEventListener("click", fetchLiveCandles);

autoRefresh.addEventListener("change", updateLiveRefresh);

[symbolInput, intervalSelect].forEach((control) => {
  control.addEventListener("change", () => {
    if (autoRefresh.checked) fetchLiveCandles();
  });
});

if (window.createStockSearch && symbolSuggestions) {
  symbolSearch = window.createStockSearch({
    input: symbolInput,
    suggestions: symbolSuggestions,
    onSelect: function (item) {
      selectedSymbolName = item && item.name ? item.name : "";
      if (selectedSymbolName) {
        indicatorStatus.textContent = `Selected ${item.symbol}: ${selectedSymbolName}`;
      }
      fetchLiveCandles();
    }
  });
}

if (chartStyle) {
  chartStyle.addEventListener("change", () => {
    renderSignalChart(latestResults);
  });
}

if (expandChart && chartPanel) {
  expandChart.addEventListener("click", () => {
    chartPanel.classList.toggle("expanded");
    expandChart.textContent = chartPanel.classList.contains("expanded") ? "Collapse" : "Expand";
    renderSignalChart(latestResults);
  });
}

if (resetChart) {
  resetChart.addEventListener("click", () => {
    if (chartStyle) chartStyle.value = "candles";
    if (chartPanel) chartPanel.classList.remove("expanded");
    if (expandChart) expandChart.textContent = "Expand";
    indicatorChart.scrollLeft = 0;
    renderSignalChart(latestResults);
  });
}

loadSample.addEventListener("click", () => {
  candleInput.value = JSON.stringify(sampleCandles, null, 2);
  indicatorForm.requestSubmit();
});

exportJson.addEventListener("click", () => {
  const payload = JSON.stringify(latestResults, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "signal-results.json";
  link.click();
  URL.revokeObjectURL(url);
});

function applyUrlParams() {
  const symbol = queryParams.get("symbol");
  const interval = queryParams.get("interval");
  const shouldLoadLive = queryParams.get("live") === "1";

  if (symbol) {
    symbolInput.value = symbol.trim().toUpperCase();
  }

  if (interval && Array.from(intervalSelect.options).some((option) => option.value === interval)) {
    intervalSelect.value = interval;
  }

  if (shouldLoadLive) {
    fetchLiveCandles();
  }
}

applyUrlParams();
