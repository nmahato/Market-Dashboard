const indicatorForm = document.getElementById("indicatorForm");
const indicatorRows = document.getElementById("indicatorRows");
const indicatorStatus = document.getElementById("indicatorStatus");
const rowCount = document.getElementById("rowCount");
const buyCount = document.getElementById("buyCount");
const sellCount = document.getElementById("sellCount");
const symbolInput = document.getElementById("symbolInput");
const intervalSelect = document.getElementById("intervalSelect");
const fetchLive = document.getElementById("fetchLive");
const stockNews = document.getElementById("stockNews");
const stockNewsStatus = document.getElementById("stockNewsStatus");
const stockNewsList = document.getElementById("stockNewsList");
const indicatorChart = document.getElementById("indicatorChart");
const chartRange = document.getElementById("chartRange");
const symbolSuggestions = document.getElementById("symbolSuggestions");
const chartPanel = document.querySelector(".chart-panel");
const chartStyle = document.getElementById("chartStyle");
const expandChart = document.getElementById("expandChart");
const resetChart = document.getElementById("resetChart");
const zoomInChart = document.getElementById("zoomInChart");
const zoomOutChart = document.getElementById("zoomOutChart");
const overlayVwap = document.getElementById("overlayVwap");
const overlayEma9 = document.getElementById("overlayEma9");
const overlayEma21 = document.getElementById("overlayEma21");
const overlaySma20 = document.getElementById("overlaySma20");
const overlayVolume = document.getElementById("overlayVolume");

let latestResults = [];
let isLoadingLive = false;
let isLoadingNews = false;
let chartZoom = { start: 0, end: 1 };
const queryParams = new URLSearchParams(window.location.search);
let symbolSearch;
let selectedSymbolName = "";

class TradingIndicatorService {
  calculate(candles) {
    const results = [];
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    const ema9Values = this.calculateEMA(candles.map((item) => item.close), 9);
    const ema21Values = this.calculateEMA(candles.map((item) => item.close), 21);
    const sma20Values = this.calculateSMA(candles.map((item) => item.close), 20);

    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i];
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativePV += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;

      const vwap = cumulativeVolume ? cumulativePV / cumulativeVolume : 0;
      const ema9 = ema9Values[i];
      const ema21 = ema21Values[i];
      const sma20 = sma20Values[i];
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
        sma20,
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

  calculateSMA(values, period) {
    const sma = [];
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      sma.push(i >= period - 1 ? sum / period : undefined);
    }
    return sma;
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

function timeAgo(value) {
  if (!value) return "Unknown time";
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "Unknown time";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resetChartZoom() {
  chartZoom = { start: 0, end: 1 };
}

function getChartZoomWindow(totalCount) {
  if (totalCount < 2) return { startIndex: 0, endIndex: totalCount - 1, isZoomed: false };
  const normalizedStart = clamp(chartZoom.start, 0, 1);
  const normalizedEnd = clamp(chartZoom.end, normalizedStart, 1);
  let startIndex = Math.floor(normalizedStart * (totalCount - 1));
  let endIndex = Math.ceil(normalizedEnd * (totalCount - 1));

  if (endIndex <= startIndex) {
    endIndex = Math.min(totalCount - 1, startIndex + 1);
    startIndex = Math.max(0, endIndex - 1);
  }

  return {
    startIndex,
    endIndex,
    isZoomed: startIndex > 0 || endIndex < totalCount - 1
  };
}

function applyChartZoom(zoomFactor, cursorRatio = 0.5) {
  if (!Array.isArray(latestResults) || latestResults.length < 3) return;
  const currentStart = clamp(chartZoom.start, 0, 1);
  const currentEnd = clamp(chartZoom.end, currentStart, 1);
  const currentSpan = currentEnd - currentStart || 1;
  const minSpan = Math.min(1, Math.max(2 / latestResults.length, 0.025));
  const nextSpan = clamp(currentSpan * zoomFactor, minSpan, 1);
  const anchor = currentStart + currentSpan * cursorRatio;
  let nextStart = anchor - nextSpan * cursorRatio;
  let nextEnd = nextStart + nextSpan;

  if (nextStart < 0) {
    nextEnd -= nextStart;
    nextStart = 0;
  }
  if (nextEnd > 1) {
    nextStart -= nextEnd - 1;
    nextEnd = 1;
  }

  chartZoom = {
    start: clamp(nextStart, 0, 1),
    end: clamp(nextEnd, 0, 1)
  };
  renderSignalChart(latestResults);
}

function zoomSignalChart(event) {
  if (!Array.isArray(latestResults) || latestResults.length < 3) return;
  event.preventDefault();
  const rect = indicatorChart.getBoundingClientRect();
  const cursorRatio = rect.width
    ? clamp((event.clientX - rect.left) / rect.width, 0, 1)
    : 0.5;
  applyChartZoom(event.deltaY < 0 ? 0.78 : 1.28, cursorRatio);
}

function renderSignalChart(results) {
  if (!Array.isArray(results) || results.length < 2) {
    indicatorChart.innerHTML = "<p>No candle data calculated yet.</p>";
    chartRange.textContent = "No chart data yet.";
    return;
  }

  const totalCount = results.length;
  const zoomWindow = getChartZoomWindow(totalCount);
  const visibleResults = results.slice(zoomWindow.startIndex, zoomWindow.endIndex + 1);
  if (visibleResults.length < 2) {
    resetChartZoom();
    renderSignalChart(results);
    return;
  }
  results = visibleResults;

  const showVwap = overlayVwap ? overlayVwap.checked : true;
  const showEma9 = overlayEma9 ? overlayEma9.checked : true;
  const showEma21 = overlayEma21 ? overlayEma21.checked : true;
  const showSma20 = overlaySma20 ? overlaySma20.checked : true;
  const showVolumeBars = overlayVolume ? overlayVolume.checked : true;

  const width = 1040;
  const height = 480;
  const padding = { top: 24, right: 72, bottom: 42, left: 58 };
  const volumeAreaHeight = showVolumeBars ? 90 : 0;
  const volumeGap = showVolumeBars ? 14 : 0;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom - volumeAreaHeight - volumeGap;
  const priceValues = results.flatMap((item) => [
    item.high,
    item.low,
    showVwap ? item.vwap : null,
    showEma9 ? item.ema9 : null,
    showEma21 ? item.ema21 : null,
    showSma20 ? item.sma20 : null
  ]).filter(Number.isFinite);
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
  const sma20Points = pointsFor(results.map((item) => item.sma20), xForIndex, yForValue);
  const mode = chartStyle ? chartStyle.value : "candles";
  const showCandles = mode === "candles" || mode === "both";
  const showCloseLine = mode === "line" || mode === "both";
  const lastIndex = results.length - 1;
  const labelX = Math.min(width - padding.right + 8, xForIndex(lastIndex) + 10);
  const labelData = [["Close", results[lastIndex].close, "price-label"]];
  if (showVwap) labelData.push(["VWAP", results[lastIndex].vwap, "vwap-label"]);
  if (showEma9) labelData.push(["EMA9", results[lastIndex].ema9, "ema9-label"]);
  if (showEma21) labelData.push(["EMA21", results[lastIndex].ema21, "ema21-label"]);
  if (showSma20) labelData.push(["SMA20", results[lastIndex].sma20, "sma20-label"]);

  let volumeMarkup = "";
  if (showVolumeBars) {
    const volumeTop = padding.top + plotHeight + volumeGap;
    const volumeBottom = height - padding.bottom;
    const volumeValues = results.map((item) => item.volume).filter(Number.isFinite);
    const maxVolume = volumeValues.length ? Math.max(...volumeValues) : 1;
    const yForVolume = (volume) => volumeBottom - (Math.max(0, volume) / (maxVolume || 1)) * volumeAreaHeight;
    const bars = results.map((item, index) => {
      const x = xForIndex(index);
      const barTop = Number.isFinite(item.volume) ? yForVolume(item.volume) : volumeBottom;
      const barHeight = Math.max(1, volumeBottom - barTop);
      const directionClass = item.close >= item.open ? "up" : "down";
      return `<rect class="volume-bar ${directionClass}" x="${(x - candleBodyWidth / 2).toFixed(2)}" y="${barTop.toFixed(2)}" width="${candleBodyWidth.toFixed(2)}" height="${barHeight.toFixed(2)}"></rect>`;
    }).join("");
    volumeMarkup = `
      ${bars}
      <text class="volume-axis-label" x="${padding.left}" y="${(volumeTop - 6).toFixed(2)}">Volume</text>
      <text class="volume-axis-label" x="${width - padding.right}" y="${(volumeTop - 6).toFixed(2)}" text-anchor="end">${formatNumber(maxVolume, 0)}</text>
    `;
  }

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

  chartRange.textContent = zoomWindow.isZoomed
    ? `${results.length} of ${totalCount} candles from ${firstTime} to ${lastTime}.`
    : `${results.length} candles from ${firstTime} to ${lastTime}.`;
  indicatorChart.innerHTML = `
    <svg class="signal-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Candlestick chart with VWAP, EMA, SMA overlays and volume">
      <rect class="chart-bg" x="0" y="0" width="${width}" height="${height}"></rect>
      ${gridMarkup}
      <text class="chart-axis" x="${padding.left}" y="${height - 12}">${escapeHtml(firstTime)}</text>
      <text class="chart-axis" x="${width - padding.right}" y="${height - 12}" text-anchor="end">${escapeHtml(lastTime)}</text>
      ${showCandles ? candleMarkup : ""}
      ${showCloseLine ? `<polyline class="price-line" points="${closePoints}"></polyline>` : ""}
      ${showVwap ? `<polyline class="vwap-line" points="${vwapPoints}"></polyline>` : ""}
      ${showEma9 ? `<polyline class="ema9-line" points="${ema9Points}"></polyline>` : ""}
      ${showEma21 ? `<polyline class="ema21-line" points="${ema21Points}"></polyline>` : ""}
      ${showSma20 ? `<polyline class="sma20-line" points="${sma20Points}"></polyline>` : ""}
      ${volumeMarkup}
      ${lineLabels}
      ${markerMarkup}
    </svg>
  `;
}

function renderResults(results) {
  latestResults = results;
  resetChartZoom();
  const tableResults = [...results].sort((a, b) => {
    const first = Date.parse(a.time);
    const second = Date.parse(b.time);
    return (Number.isFinite(second) ? second : 0) - (Number.isFinite(first) ? first : 0);
  });
  rowCount.textContent = results.length;
  buyCount.textContent = results.filter((result) => result.buySignal).length;
  sellCount.textContent = results.filter((result) => result.sellSignal).length;
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

    const service = new TradingIndicatorService();
    renderResults(service.calculate(payload.candles));
    indicatorStatus.textContent = `Live ${payload.symbol} ${payload.interval}: ${payload.candles.length} candles, updated ${formatTime(payload.updatedAt)}.`;
    loadStockNews(symbol);
  } catch (error) {
    indicatorStatus.textContent = error.message;
  } finally {
    isLoadingLive = false;
    fetchLive.disabled = false;
  }
}

indicatorForm.addEventListener("submit", (event) => {
  event.preventDefault();
  fetchLiveCandles();
});

fetchLive.addEventListener("click", fetchLiveCandles);

async function resolveCurrentSymbol() {
  let symbol = symbolInput.value.trim().toUpperCase();
  if (!symbol) throw new Error("Enter a symbol first.");
  if (window.resolveStockSymbol) {
    symbol = await window.resolveStockSymbol(symbol);
    symbolInput.value = symbol;
  }
  return symbol;
}

function renderStockNews(payload) {
  const articles = Array.isArray(payload.articles) ? payload.articles : [];
  const query = payload.query || symbolInput.value.trim().toUpperCase();
  stockNewsStatus.textContent = articles.length
    ? `${articles.length} current headlines for ${query}.`
    : `No current headlines found for ${query}.`;

  if (!articles.length) {
    stockNewsList.innerHTML = '<p class="loading">No headlines found.</p>';
    return;
  }

  stockNewsList.innerHTML = articles.slice(0, 8).map((article) => {
    const tickers = Array.isArray(article.relatedTickers) && article.relatedTickers.length
      ? `<div class="news-tickers">${article.relatedTickers.slice(0, 6).map((ticker) => `<span>${escapeHtml(ticker)}</span>`).join("")}</div>`
      : "";
    const thumbnail = article.thumbnail
      ? `<img src="${escapeHtml(article.thumbnail)}" alt="">`
      : '<div class="news-thumb-placeholder"></div>';

    return `
      <article class="news-card">
        <a href="${escapeHtml(article.link)}" target="_blank" rel="noreferrer">
          ${thumbnail}
          <div>
            <div class="news-meta">
              <span>${escapeHtml(article.publisher || "Market news")}</span>
              <span>${escapeHtml(timeAgo(article.publishedAt))}</span>
            </div>
            <h2>${escapeHtml(article.title)}</h2>
            ${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ""}
            ${tickers}
          </div>
        </a>
      </article>
    `;
  }).join("");
}

async function loadStockNews(symbolValue) {
  if (isLoadingNews || !stockNewsList || !stockNewsStatus) return;
  isLoadingNews = true;
  if (stockNews) stockNews.disabled = true;
  try {
    const symbol = symbolValue || await resolveCurrentSymbol();
    stockNewsStatus.textContent = `Loading current news for ${symbol}...`;
    const response = await fetch(`/api/news?q=${encodeURIComponent(symbol)}&symbols=&limit=8`, {
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    renderStockNews(payload);
  } catch (error) {
    stockNewsStatus.textContent = error.message;
    stockNewsList.innerHTML = '<p class="loading">Unable to load current news.</p>';
  } finally {
    isLoadingNews = false;
    if (stockNews) stockNews.disabled = false;
  }
}

if (stockNews) {
  stockNews.addEventListener("click", () => {
    loadStockNews();
  });
}

[symbolInput, intervalSelect].forEach((control) => {
  control.addEventListener("change", () => {
    fetchLiveCandles();
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

[overlayVwap, overlayEma9, overlayEma21, overlaySma20, overlayVolume].forEach((checkbox) => {
  if (checkbox) {
    checkbox.addEventListener("change", () => renderSignalChart(latestResults));
  }
});

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
    [overlayVwap, overlayEma9, overlayEma21, overlaySma20, overlayVolume].forEach((checkbox) => {
      if (checkbox) checkbox.checked = true;
    });
    resetChartZoom();
    indicatorChart.scrollLeft = 0;
    renderSignalChart(latestResults);
  });
}

if (zoomInChart) {
  zoomInChart.addEventListener("click", () => applyChartZoom(0.78));
}

if (zoomOutChart) {
  zoomOutChart.addEventListener("click", () => applyChartZoom(1.28));
}

indicatorChart.addEventListener("wheel", zoomSignalChart, { passive: false });

function applyUrlParams() {
  const symbol = queryParams.get("symbol");
  const interval = queryParams.get("interval");

  if (symbol) {
    symbolInput.value = symbol.trim().toUpperCase();
  }

  if (interval && Array.from(intervalSelect.options).some((option) => option.value === interval)) {
    intervalSelect.value = interval;
  }

  fetchLiveCandles();
}

applyUrlParams();
