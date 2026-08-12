const chartForm = document.getElementById("chartForm");
const indicatorStatus = document.getElementById("indicatorStatus");
const trendState = document.getElementById("trendState");
const buyCount = document.getElementById("buyCount");
const sellCount = document.getElementById("sellCount");
const lastSignal = document.getElementById("lastSignal");
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
const saveChartImage = document.getElementById("saveChartImage");
const zoomInChart = document.getElementById("zoomInChart");
const zoomOutChart = document.getElementById("zoomOutChart");
const overlayEma9 = document.getElementById("overlayEma9");
const overlayEma21 = document.getElementById("overlayEma21");
const overlayVolume = document.getElementById("overlayVolume");
const overlayMacd = document.getElementById("overlayMacd");
const statusText = document.getElementById("statusText");
const connectionDot = document.getElementById("connectionDot");
const countdown = document.getElementById("countdown");
const newsModal = document.getElementById("newsModal");
const newsModalClose = document.getElementById("newsModalClose");
const newsModalPublisher = document.getElementById("newsModalPublisher");
const newsModalTime = document.getElementById("newsModalTime");
const newsModalTitle = document.getElementById("newsModalTitle");
const newsModalSummary = document.getElementById("newsModalSummary");
const newsModalTickers = document.getElementById("newsModalTickers");
const newsModalLink = document.getElementById("newsModalLink");

let latestResults = [];
let timeIndexMap = new Map();
let isLoadingLive = false;
let isLoadingNews = false;
let currentArticles = [];
const queryParams = new URLSearchParams(window.location.search);
let symbolSearch;
let selectedSymbolName = "";

const SIGNAL_COOLDOWN_BARS = 5;
const VOLUME_CONFIRM_MULTIPLIER = 1.2;
const ATR_STOP_MULTIPLIER = 1.5;
const ATR_TP2_MULTIPLIER = 3;

class TradingChartService {
  calculate(candles) {
    const results = [];
    const closes = candles.map((item) => item.close);
    const ema9Values = this.calculateEMA(closes, 9);
    const ema21Values = this.calculateEMA(closes, 21);
    const ema12Values = this.calculateEMA(closes, 12);
    const ema26Values = this.calculateEMA(closes, 26);
    const macdLineValues = ema12Values.map((value, index) => value - ema26Values[index]);
    const macdSignalValues = this.calculateEMA(macdLineValues, 9);
    const macdHistogramValues = macdLineValues.map((value, index) => value - macdSignalValues[index]);
    const atrValues = this.calculateATR(candles, 14);

    let lastBuyIndex = -Infinity;
    let lastSellIndex = -Infinity;

    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i];
      const ema9 = ema9Values[i];
      const ema21 = ema21Values[i];
      const macdLine = macdLineValues[i];
      const macdSignal = macdSignalValues[i];
      const macdHistogram = macdHistogramValues[i];
      const atr = atrValues[i];
      const avgVolume = this.averageVolume(candles, i, 20);

      const trendUp = ema9 > ema21;
      const trendDown = ema9 < ema21;
      const momentumUp = macdHistogram > 0;
      const momentumDown = macdHistogram < 0;
      const volumeConfirmed = candle.volume > avgVolume * VOLUME_CONFIRM_MULTIPLIER;
      const hasAtr = Number.isFinite(atr);

      const buyBase = trendUp && momentumUp && volumeConfirmed && hasAtr;
      const sellBase = trendDown && momentumDown && volumeConfirmed && hasAtr;
      const buySignal = buyBase && (i - lastBuyIndex) >= SIGNAL_COOLDOWN_BARS;
      const sellSignal = sellBase && (i - lastSellIndex) >= SIGNAL_COOLDOWN_BARS;
      if (buySignal) lastBuyIndex = i;
      if (sellSignal) lastSellIndex = i;

      let entryPrice;
      let tp1;
      let tp2;
      let stopLoss;

      if (buySignal) {
        entryPrice = candle.close;
        stopLoss = entryPrice - atr * ATR_STOP_MULTIPLIER;
        tp1 = entryPrice + atr * ATR_STOP_MULTIPLIER;
        tp2 = entryPrice + atr * ATR_TP2_MULTIPLIER;
      }

      if (sellSignal) {
        entryPrice = candle.close;
        stopLoss = entryPrice + atr * ATR_STOP_MULTIPLIER;
        tp1 = entryPrice - atr * ATR_STOP_MULTIPLIER;
        tp2 = entryPrice - atr * ATR_TP2_MULTIPLIER;
      }

      results.push({
        ...candle,
        ema9,
        ema21,
        macdLine,
        macdSignal,
        macdHistogram,
        atr,
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

  calculateATR(candles, period) {
    const atr = [];
    let trSum = 0;
    for (let i = 0; i < candles.length; i += 1) {
      const candle = candles[i];
      const prevClose = i > 0 ? candles[i - 1].close : candle.close;
      const trueRange = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prevClose),
        Math.abs(candle.low - prevClose)
      );

      if (i < period - 1) {
        trSum += trueRange;
        atr.push(undefined);
      } else if (i === period - 1) {
        trSum += trueRange;
        atr.push(trSum / period);
      } else {
        const prevAtr = atr[i - 1];
        atr.push((prevAtr * (period - 1) + trueRange) / period);
      }
    }
    return atr;
  }

  averageVolume(candles, index, period) {
    const start = Math.max(0, index - period + 1);
    const slice = candles.slice(start, index + 1);
    return slice.reduce((sum, candle) => sum + candle.volume, 0) / slice.length;
  }
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

function toUnixTime(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

function readCssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function withAlpha(color, alpha) {
  if (!color) return `rgba(148, 163, 184, ${alpha})`;
  if (color.startsWith("#")) {
    const hex = color.length === 4
      ? color.slice(1).split("").map((char) => char + char).join("")
      : color.slice(1);
    const value = parseInt(hex, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const match = color.match(/[\d.]+/g);
  if (match && match.length >= 3) {
    return `rgba(${match[0]}, ${match[1]}, ${match[2]}, ${alpha})`;
  }
  return color;
}

function getThemeColors() {
  return {
    text: readCssVar("--text", "#1d2430"),
    muted: readCssVar("--muted", "#6b7685"),
    panelBg: readCssVar("--surface-sunken", "#f4f6f9"),
    grid: readCssVar("--chart-grid", "rgba(148, 163, 184, 0.18)"),
    line: readCssVar("--line", "#e2e6ec"),
    buy: readCssVar("--buy", "#1f9d55"),
    hot: readCssVar("--hot", "#d1483c")
  };
}

let chart;
let candleSeries;
let closeLineSeries;
let ema9Series;
let ema21Series;
let volumeSeries;
let macdHistSeries;
let macdLineSeries;
let macdSignalSeries;
let markersPlugin;
let crosshairInfo;
let activeSeriesKey = null;

function initChart() {
  const colors = getThemeColors();

  chart = LightweightCharts.createChart(indicatorChart, {
    autoSize: true,
    layout: {
      background: { type: LightweightCharts.ColorType.Solid, color: colors.panelBg },
      textColor: colors.text,
      panes: { separatorColor: colors.line }
    },
    grid: {
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid }
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: colors.line },
    timeScale: { borderColor: colors.line, timeVisible: true, secondsVisible: false }
  });

  candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: colors.buy,
    downColor: colors.hot,
    borderUpColor: colors.buy,
    borderDownColor: colors.hot,
    wickUpColor: colors.buy,
    wickDownColor: colors.hot,
    priceLineVisible: false
  });

  closeLineSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: colors.text,
    lineWidth: 2,
    visible: false,
    priceLineVisible: false,
    lastValueVisible: false
  });

  ema9Series = chart.addSeries(LightweightCharts.LineSeries, {
    color: colors.buy,
    lineWidth: 1.5,
    priceLineVisible: false,
    lastValueVisible: true,
    title: "EMA9"
  });

  ema21Series = chart.addSeries(LightweightCharts.LineSeries, {
    color: "#c46a00",
    lineWidth: 1.5,
    priceLineVisible: false,
    lastValueVisible: true,
    title: "EMA21"
  });

  volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: "volume" },
    priceLineVisible: false,
    lastValueVisible: false
  }, 1);

  macdHistSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceLineVisible: false,
    lastValueVisible: false
  }, 2);

  macdLineSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: "#2f6fed",
    lineWidth: 1.5,
    priceLineVisible: false,
    lastValueVisible: true,
    title: "MACD"
  }, 2);

  macdSignalSeries = chart.addSeries(LightweightCharts.LineSeries, {
    color: "#e0a300",
    lineWidth: 1.2,
    priceLineVisible: false,
    lastValueVisible: true,
    title: "Signal"
  }, 2);

  markersPlugin = LightweightCharts.createSeriesMarkers(candleSeries, []);

  const panes = chart.panes();
  if (panes[1]) panes[1].setHeight(90);
  if (panes[2]) panes[2].setHeight(110);

  crosshairInfo = document.createElement("div");
  crosshairInfo.className = "chart-crosshair-info";
  indicatorChart.appendChild(crosshairInfo);

  chart.subscribeCrosshairMove(handleCrosshairMove);

  const themeObserver = new MutationObserver(() => applyChartTheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function applyChartTheme() {
  if (!chart) return;
  const colors = getThemeColors();
  chart.applyOptions({
    layout: {
      background: { type: LightweightCharts.ColorType.Solid, color: colors.panelBg },
      textColor: colors.text,
      panes: { separatorColor: colors.line }
    },
    grid: {
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid }
    },
    rightPriceScale: { borderColor: colors.line },
    timeScale: { borderColor: colors.line }
  });
  candleSeries.applyOptions({
    upColor: colors.buy,
    downColor: colors.hot,
    borderUpColor: colors.buy,
    borderDownColor: colors.hot,
    wickUpColor: colors.buy,
    wickDownColor: colors.hot
  });
  closeLineSeries.applyOptions({ color: colors.text });
  ema9Series.applyOptions({ color: colors.buy });
  renderChartData(latestResults, activeSeriesKey);
}

function applyOverlayVisibility() {
  const mode = chartStyle ? chartStyle.value : "candles";
  candleSeries.applyOptions({ visible: mode === "candles" || mode === "both" });
  closeLineSeries.applyOptions({ visible: mode === "line" || mode === "both" });
  ema9Series.applyOptions({ visible: overlayEma9 ? overlayEma9.checked : true });
  ema21Series.applyOptions({ visible: overlayEma21 ? overlayEma21.checked : true });
  const showVolume = overlayVolume ? overlayVolume.checked : true;
  volumeSeries.applyOptions({ visible: showVolume });
  const showMacd = overlayMacd ? overlayMacd.checked : true;
  macdHistSeries.applyOptions({ visible: showMacd });
  macdLineSeries.applyOptions({ visible: showMacd });
  macdSignalSeries.applyOptions({ visible: showMacd });
}

function renderChartData(results, seriesKey) {
  if (!chart) return;
  if (!Array.isArray(results) || !results.length) {
    chartRange.textContent = "No chart data yet.";
    return;
  }

  const colors = getThemeColors();
  const candleData = results.map((item) => ({
    time: toUnixTime(item.time), open: item.open, high: item.high, low: item.low, close: item.close
  }));
  const closeData = results.map((item) => ({ time: toUnixTime(item.time), value: item.close }));
  const ema9Data = results.filter((item) => Number.isFinite(item.ema9))
    .map((item) => ({ time: toUnixTime(item.time), value: item.ema9 }));
  const ema21Data = results.filter((item) => Number.isFinite(item.ema21))
    .map((item) => ({ time: toUnixTime(item.time), value: item.ema21 }));
  const volumeData = results.map((item) => ({
    time: toUnixTime(item.time),
    value: item.volume,
    color: withAlpha(item.close >= item.open ? colors.buy : colors.hot, 0.55)
  }));
  const macdHistData = results.filter((item) => Number.isFinite(item.macdHistogram)).map((item) => ({
    time: toUnixTime(item.time),
    value: item.macdHistogram,
    color: withAlpha(item.macdHistogram >= 0 ? colors.buy : colors.hot, 0.6)
  }));
  const macdLineData = results.filter((item) => Number.isFinite(item.macdLine))
    .map((item) => ({ time: toUnixTime(item.time), value: item.macdLine }));
  const macdSignalData = results.filter((item) => Number.isFinite(item.macdSignal))
    .map((item) => ({ time: toUnixTime(item.time), value: item.macdSignal }));

  const isNewSeries = seriesKey !== activeSeriesKey;
  const prevRange = !isNewSeries ? chart.timeScale().getVisibleLogicalRange() : null;

  candleSeries.setData(candleData);
  closeLineSeries.setData(closeData);
  ema9Series.setData(ema9Data);
  ema21Series.setData(ema21Data);
  volumeSeries.setData(volumeData);
  macdHistSeries.setData(macdHistData);
  macdLineSeries.setData(macdLineData);
  macdSignalSeries.setData(macdSignalData);

  const markers = results.filter((item) => item.buySignal || item.sellSignal).map((item) => ({
    time: toUnixTime(item.time),
    position: item.buySignal ? "belowBar" : "aboveBar",
    color: item.buySignal ? colors.buy : colors.hot,
    shape: item.buySignal ? "arrowUp" : "arrowDown",
    text: item.buySignal ? "BUY" : "SELL"
  }));
  markersPlugin.setMarkers(markers);

  applyOverlayVisibility();
  activeSeriesKey = seriesKey;

  if (prevRange) {
    chart.timeScale().setVisibleLogicalRange(prevRange);
  } else {
    chart.timeScale().fitContent();
  }

  const firstTime = formatTime(results[0].time);
  const lastTime = formatTime(results[results.length - 1].time);
  chartRange.textContent = `${results.length} candles from ${firstTime} to ${lastTime}.`;

  updateCrosshairInfo(results[results.length - 1]);
}

function updateCrosshairInfo(item) {
  if (!crosshairInfo) return;
  if (!item) {
    crosshairInfo.innerHTML = "";
    return;
  }
  const changeClass = item.close >= item.open ? "up" : "down";
  crosshairInfo.innerHTML = `
    <span class="ohlc-time">${escapeHtml(formatTime(item.time))}</span>
    <span class="${changeClass}">O ${formatNumber(item.open)}</span>
    <span class="${changeClass}">H ${formatNumber(item.high)}</span>
    <span class="${changeClass}">L ${formatNumber(item.low)}</span>
    <span class="${changeClass}">C ${formatNumber(item.close)}</span>
    <span class="ema9-label">EMA9 ${formatNumber(item.ema9)}</span>
    <span class="ema21-label">EMA21 ${formatNumber(item.ema21)}</span>
    <span class="macd-label">MACD ${formatNumber(item.macdHistogram)}</span>
    <span class="volume-label">Vol ${formatNumber(item.volume, 0)}</span>
  `;
}

function handleCrosshairMove(param) {
  if (!latestResults.length) return;
  if (!param || param.time === undefined) {
    updateCrosshairInfo(latestResults[latestResults.length - 1]);
    return;
  }
  const index = timeIndexMap.get(param.time);
  updateCrosshairInfo(index !== undefined ? latestResults[index] : latestResults[latestResults.length - 1]);
}

function applyZoom(factor) {
  if (!chart) return;
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) return;
  const center = (range.from + range.to) / 2;
  const span = Math.max((range.to - range.from) * factor, 2);
  chart.timeScale().setVisibleLogicalRange({ from: center - span / 2, to: center + span / 2 });
}

function updateSummary(results) {
  const buySignals = results.filter((result) => result.buySignal);
  const sellSignals = results.filter((result) => result.sellSignal);
  buyCount.textContent = buySignals.length;
  sellCount.textContent = sellSignals.length;

  const latest = results[results.length - 1];
  if (latest) {
    if (latest.ema9 > latest.ema21) {
      trendState.textContent = "Uptrend";
    } else if (latest.ema9 < latest.ema21) {
      trendState.textContent = "Downtrend";
    } else {
      trendState.textContent = "Neutral";
    }
  } else {
    trendState.textContent = "--";
  }

  const allSignals = [...buySignals, ...sellSignals].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const mostRecent = allSignals[0];
  lastSignal.textContent = mostRecent
    ? `${mostRecent.buySignal ? "BUY" : "SELL"} ${formatTime(mostRecent.time)}`
    : "--";
}

function renderResults(results, seriesKey) {
  latestResults = results;
  timeIndexMap = new Map(results.map((item, index) => [toUnixTime(item.time), index]));
  updateSummary(results);
  renderChartData(results, seriesKey);
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
  statusText.textContent = "Refreshing";
  countdown.textContent = "now";
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

    const service = new TradingChartService();
    renderResults(service.calculate(payload.candles), `${payload.symbol}:${payload.interval}`);
    indicatorStatus.textContent = `Live ${payload.symbol} ${payload.interval}: ${payload.candles.length} candles, updated ${formatTime(payload.updatedAt)}.`;
    statusText.textContent = "Live";
    connectionDot.className = "dot live";
  } catch (error) {
    indicatorStatus.textContent = error.message;
    statusText.textContent = "Data error";
    connectionDot.className = "dot error";
  } finally {
    isLoadingLive = false;
    fetchLive.disabled = false;
    nextRefresh = refreshSeconds;
    countdown.textContent = `${nextRefresh}s`;
  }
}

chartForm.addEventListener("submit", (event) => {
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
  currentArticles = articles.slice(0, 8);
  stockNewsStatus.textContent = currentArticles.length
    ? `${currentArticles.length} current headlines for ${query}.`
    : `No current headlines found for ${query}.`;

  if (!currentArticles.length) {
    stockNewsList.innerHTML = '<p class="loading">No headlines found.</p>';
    return;
  }

  stockNewsList.innerHTML = currentArticles.map((article, index) => {
    const tickers = Array.isArray(article.relatedTickers) && article.relatedTickers.length
      ? `<div class="news-tickers">${article.relatedTickers.slice(0, 6).map((ticker) => `<span>${escapeHtml(ticker)}</span>`).join("")}</div>`
      : "";

    return `
      <article class="news-card" data-news-index="${index}" tabindex="0" role="button" aria-haspopup="dialog">
        <div class="news-meta">
          <span>${escapeHtml(article.publisher || "Market news")}</span>
          <span>${escapeHtml(timeAgo(article.publishedAt))}</span>
        </div>
        <h2>${escapeHtml(article.title)}</h2>
        ${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ""}
        ${tickers}
      </article>
    `;
  }).join("");
}

function openNewsModal(article) {
  if (!article) return;
  newsModalPublisher.textContent = article.publisher || "Market news";
  newsModalTime.textContent = timeAgo(article.publishedAt);
  newsModalTitle.textContent = article.title || "Untitled";
  newsModalSummary.textContent = article.summary
    ? article.summary
    : "This publisher didn't provide a summary. Use the link below to read the full story.";
  newsModalTickers.innerHTML = Array.isArray(article.relatedTickers) && article.relatedTickers.length
    ? article.relatedTickers.slice(0, 8).map((ticker) => `<span>${escapeHtml(ticker)}</span>`).join("")
    : "";
  newsModalLink.href = article.link || "#";
  newsModal.hidden = false;
  newsModalClose.focus();
}

function closeNewsModal() {
  newsModal.hidden = true;
}

stockNewsList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-news-index]");
  if (!card) return;
  openNewsModal(currentArticles[Number(card.dataset.newsIndex)]);
});

stockNewsList.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-news-index]");
  if (!card) return;
  event.preventDefault();
  openNewsModal(currentArticles[Number(card.dataset.newsIndex)]);
});

newsModalClose.addEventListener("click", closeNewsModal);
newsModal.addEventListener("click", (event) => {
  if (event.target === newsModal) closeNewsModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !newsModal.hidden) closeNewsModal();
});

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

const newsRefreshSeconds = 5;
setInterval(() => {
  if (symbolInput.value.trim()) loadStockNews();
}, newsRefreshSeconds * 1000);

[symbolInput, intervalSelect].forEach((control) => {
  control.addEventListener("change", () => {
    fetchLiveCandles();
    loadStockNews();
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
      loadStockNews();
    }
  });
}

if (chartStyle) {
  chartStyle.addEventListener("change", applyOverlayVisibility);
}

[overlayEma9, overlayEma21, overlayVolume, overlayMacd].forEach((checkbox) => {
  if (checkbox) {
    checkbox.addEventListener("change", applyOverlayVisibility);
  }
});

if (expandChart && chartPanel) {
  expandChart.addEventListener("click", () => {
    chartPanel.classList.toggle("expanded");
    expandChart.textContent = chartPanel.classList.contains("expanded") ? "Collapse" : "Expand";
  });
}

if (resetChart) {
  resetChart.addEventListener("click", () => {
    if (chartStyle) chartStyle.value = "candles";
    if (chartPanel) chartPanel.classList.remove("expanded");
    if (expandChart) expandChart.textContent = "Expand";
    [overlayEma9, overlayEma21, overlayVolume, overlayMacd].forEach((checkbox) => {
      if (checkbox) checkbox.checked = true;
    });
    applyOverlayVisibility();
    if (chart) chart.timeScale().fitContent();
  });
}

if (zoomInChart) {
  zoomInChart.addEventListener("click", () => applyZoom(0.7));
}

if (zoomOutChart) {
  zoomOutChart.addEventListener("click", () => applyZoom(1.4));
}

if (saveChartImage) {
  saveChartImage.addEventListener("click", () => {
    if (!chart) return;
    const canvas = chart.takeScreenshot();
    const symbol = symbolInput.value.trim().toUpperCase() || "chart";
    const interval = intervalSelect.value || "";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const link = document.createElement("a");
    link.download = `${symbol}-${interval}-${stamp}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  });
}

const refreshSeconds = 1;
let nextRefresh = refreshSeconds;

setInterval(() => {
  nextRefresh -= 1;
  if (nextRefresh <= 0 && !isLoadingLive) {
    fetchLiveCandles();
  }
  countdown.textContent = isLoadingLive ? "now" : `${Math.max(nextRefresh, 0)}s`;
}, 1000);

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
  loadStockNews();
}

initChart();
applyUrlParams();
