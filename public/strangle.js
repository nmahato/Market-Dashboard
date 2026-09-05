const fields = {
  form: document.getElementById("strangleForm"),
  symbol: document.getElementById("strangleSymbol"),
  suggestions: document.getElementById("strangleSymbolSuggestions"),
  spot: document.getElementById("strangleStockPrice"),
  contracts: document.getElementById("strangleContracts"),
  putStrike: document.getElementById("putStrike"),
  putStrikeSlider: document.getElementById("putStrikeSlider"),
  putPremium: document.getElementById("putPremium"),
  putVolatility: document.getElementById("putVolatility"),
  callStrike: document.getElementById("callStrike"),
  callStrikeSlider: document.getElementById("callStrikeSlider"),
  callPremium: document.getElementById("callPremium"),
  callVolatility: document.getElementById("callVolatility"),
  expiration: document.getElementById("strangleExpiration"),
  rate: document.getElementById("strangleRate"),
  dividend: document.getElementById("strangleDividend"),
  projectionDate: document.getElementById("strangleProjectionDate"),
  projectedPrice: document.getElementById("strangleProjectedPrice"),
  projectedPriceValue: document.getElementById("strangleProjectedPriceValue"),
  status: document.getElementById("strangleStatus"),
  loadQuote: document.getElementById("loadStrangleQuote")
};
const terminal = {
  symbol: document.getElementById("terminalSymbol"), spot: document.getElementById("terminalSpot"),
  state: document.getElementById("terminalQuoteState"), days: document.getElementById("terminalDays"),
  expirations: document.getElementById("terminalExpirations"), ticks: document.getElementById("strikeRulerTicks"),
  putMarker: document.getElementById("putStrikeMarker"), callMarker: document.getElementById("callStrikeMarker"),
  spotMarker: document.getElementById("spotMarker"), debit: document.getElementById("terminalDebit"),
  maxLoss: document.getElementById("terminalMaxLoss"), probability: document.getElementById("terminalProbability"),
  breakevens: document.getElementById("terminalBreakevens"), edit: document.getElementById("terminalEditLegs"),
  reset: document.getElementById("terminalReset")
};

function inputNumber(input, fallback = 0) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function yearsBetween(from, to) {
  return Math.max(0, (to.getTime() - from.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
}

function optionPrices(spot, strike, years, sigma, rate, dividend) {
  if (years <= 0 || sigma <= 0) {
    return { call: Math.max(0, spot - strike), put: Math.max(0, strike - spot) };
  }
  const rootTime = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate - dividend + sigma * sigma / 2) * years) / (sigma * rootTime);
  const d2 = d1 - sigma * rootTime;
  return {
    call: spot * Math.exp(-dividend * years) * normalCdf(d1) - strike * Math.exp(-rate * years) * normalCdf(d2),
    put: strike * Math.exp(-rate * years) * normalCdf(-d2) - spot * Math.exp(-dividend * years) * normalCdf(-d1)
  };
}

function readStrangle() {
  const expiration = new Date(`${fields.expiration.value}T16:00:00`);
  if (!fields.expiration.value || Number.isNaN(expiration.getTime())) throw new Error("Choose a valid expiration date.");
  const strategy = {
    spot: Math.max(0.01, inputNumber(fields.spot, 0.01)),
    contracts: Math.max(1, Math.floor(inputNumber(fields.contracts, 1))),
    putStrike: Math.max(0.01, inputNumber(fields.putStrike, 0.01)),
    putPremium: Math.max(0, inputNumber(fields.putPremium)),
    putSigma: Math.max(0.001, inputNumber(fields.putVolatility, 20) / 100),
    callStrike: Math.max(0.01, inputNumber(fields.callStrike, 0.01)),
    callPremium: Math.max(0, inputNumber(fields.callPremium)),
    callSigma: Math.max(0.001, inputNumber(fields.callVolatility, 20) / 100),
    expiration,
    rate: inputNumber(fields.rate) / 100,
    dividend: Math.max(0, inputNumber(fields.dividend) / 100)
  };
  if (strategy.putStrike >= strategy.callStrike) throw new Error("For a strangle, the put strike must be below the call strike.");
  return strategy;
}

function projectedResult(strategy, futureSpot, date) {
  const remaining = yearsBetween(date, strategy.expiration);
  const put = optionPrices(futureSpot, strategy.putStrike, remaining, strategy.putSigma, strategy.rate, strategy.dividend).put;
  const call = optionPrices(futureSpot, strategy.callStrike, remaining, strategy.callSigma, strategy.rate, strategy.dividend).call;
  const value = (put + call) * 100 * strategy.contracts;
  const debit = (strategy.putPremium + strategy.callPremium) * 100 * strategy.contracts;
  return { put, call, value, profit: value - debit };
}

function dateValue(date) {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())).toISOString().slice(0, 10);
}

function expirationChoices(selected) {
  const dates = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() + ((5 - cursor.getDay() + 7) % 7 || 7));
  for (let index = 0; index < 10; index += 1) {
    dates.push(dateValue(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  for (let offset = 1; offset <= 6; offset += 1) {
    const first = new Date(new Date().getFullYear(), new Date().getMonth() + offset, 1);
    const thirdFriday = 1 + ((5 - first.getDay() + 7) % 7) + 14;
    dates.push(dateValue(new Date(first.getFullYear(), first.getMonth(), thirdFriday)));
  }
  dates.push(selected);
  return Array.from(new Set(dates)).sort().filter((value) => value >= new Date().toISOString().slice(0, 10));
}

function modelProfitProbability(strategy, lower, upper) {
  const time = yearsBetween(new Date(), strategy.expiration);
  const sigma = (strategy.putSigma + strategy.callSigma) / 2;
  if (time <= 0 || sigma <= 0 || lower <= 0) return 0;
  const drift = (strategy.rate - strategy.dividend - sigma * sigma / 2) * time;
  const deviation = sigma * Math.sqrt(time);
  const lowerZ = (Math.log(lower / strategy.spot) - drift) / deviation;
  const upperZ = (Math.log(upper / strategy.spot) - drift) / deviation;
  return Math.max(0, Math.min(1, normalCdf(lowerZ) + 1 - normalCdf(upperZ)));
}

function renderTerminal(strategy) {
  const premiumPerShare = strategy.putPremium + strategy.callPremium;
  const debit = premiumPerShare * 100 * strategy.contracts;
  const lower = strategy.putStrike - premiumPerShare;
  const upper = strategy.callStrike + premiumPerShare;
  const days = Math.max(0, Math.ceil((strategy.expiration - new Date()) / 86400000));
  terminal.symbol.textContent = fields.symbol.value.trim().toUpperCase();
  terminal.spot.textContent = formatMoney(strategy.spot);
  terminal.days.textContent = `${days} day${days === 1 ? "" : "s"}`;
  terminal.debit.textContent = formatMoney(debit);
  terminal.maxLoss.textContent = formatMoney(-debit);
  terminal.probability.textContent = `${(modelProfitProbability(strategy, lower, upper) * 100).toFixed(1)}%`;
  terminal.breakevens.textContent = `${formatMoney(lower)} / ${formatMoney(upper)}`;
  terminal.expirations.innerHTML = expirationChoices(fields.expiration.value).map((value) => {
    const date = new Date(`${value}T12:00:00`);
    return `<button type="button" data-expiration="${value}" class="${value === fields.expiration.value ? "active" : ""}"><span>${date.toLocaleDateString("en-US", { month: "short" })}</span><strong>${date.getDate()}</strong></button>`;
  }).join("");

  const minimum = Math.max(0.5, Math.min(strategy.putStrike, strategy.spot, strategy.callStrike) * 0.94);
  const maximum = Math.max(strategy.putStrike, strategy.spot, strategy.callStrike) * 1.06;
  const markerPosition = (value) => Math.max(0, Math.min(100, ((value - minimum) / (maximum - minimum)) * 100));
  terminal.ticks.innerHTML = Array.from({ length: 9 }, (_, index) => {
    const value = minimum + (maximum - minimum) * index / 8;
    return `<span style="left:${index * 12.5}%"><i></i><strong>${Math.round(value)}</strong></span>`;
  }).join("");
  terminal.putMarker.style.left = `${markerPosition(strategy.putStrike)}%`;
  terminal.callMarker.style.left = `${markerPosition(strategy.callStrike)}%`;
  terminal.spotMarker.style.left = `${markerPosition(strategy.spot)}%`;
  terminal.putMarker.querySelector("strong").textContent = `${strategy.putStrike.toFixed(0)}P`;
  terminal.callMarker.querySelector("strong").textContent = `${strategy.callStrike.toFixed(0)}C`;
}

function payoffChart(strategy, date) {
  const width = 980;
  const height = 360;
  const padding = { top: 24, right: 30, bottom: 42, left: 72 };
  const low = Math.max(0.01, strategy.spot * 0.55);
  const high = Math.max(strategy.spot * 1.45, strategy.callStrike * 1.25);
  const points = Array.from({ length: 91 }, (_, index) => {
    const price = low + ((high - low) * index / 90);
    return { price, profit: projectedResult(strategy, price, date).profit };
  });
  const profits = points.map((point) => point.profit);
  const minimum = Math.min(...profits, 0);
  const maximum = Math.max(...profits, 0);
  const range = maximum - minimum || 1;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (price) => padding.left + ((price - low) / (high - low)) * plotWidth;
  const y = (profit) => padding.top + ((maximum - profit) / range) * plotHeight;
  const zeroY = y(0);
  const line = points.map((point) => `${x(point.price).toFixed(2)},${y(point.profit).toFixed(2)}`).join(" ");
  const priceTicks = Array.from({ length: 6 }, (_, index) => low + ((high - low) * index / 5));
  const profitTicks = Array.from({ length: 5 }, (_, index) => maximum - (range * index / 4));
  return `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Projected long strangle profit and loss by stock price">
      <rect class="option-chart-bg" width="${width}" height="${height}"></rect>
      ${profitTicks.map((tick) => `<line class="option-chart-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y(tick)}" y2="${y(tick)}"></line><text class="option-chart-axis" x="${padding.left - 10}" y="${y(tick) + 4}" text-anchor="end">${formatMoney(tick)}</text>`).join("")}
      <rect class="option-loss-zone" x="${padding.left}" y="${zeroY}" width="${plotWidth}" height="${Math.max(0, height - padding.bottom - zeroY)}"></rect>
      <line class="option-zero-line" x1="${padding.left}" x2="${width - padding.right}" y1="${zeroY}" y2="${zeroY}"></line>
      <polyline class="option-profit-line strangle-profit-line" points="${line}"></polyline>
      ${priceTicks.map((tick) => `<text class="option-chart-axis" x="${x(tick)}" y="${height - 14}" text-anchor="middle">${formatMoney(tick)}</text>`).join("")}
    </svg>`;
}

function updateProjection(strategy = readStrangle()) {
  const date = new Date(`${fields.projectionDate.value}T16:00:00`);
  const price = inputNumber(fields.projectedPrice, strategy.spot);
  const result = projectedResult(strategy, price, date);
  fields.projectedPriceValue.textContent = formatMoney(price);
  document.getElementById("projectedStrangleValue").textContent = formatMoney(result.value);
  const profit = document.getElementById("projectedStrangleProfit");
  profit.textContent = formatMoney(result.profit);
  profit.className = result.profit >= 0 ? "positive" : "negative";
  document.getElementById("stranglePayoffChart").innerHTML = payoffChart(strategy, date);
}

function recalculateStrangle() {
  try {
    const strategy = readStrangle();
    const strikeRangeLow = Math.max(0.5, Math.floor(Math.min(strategy.spot, strategy.putStrike) * 0.5));
    const strikeRangeHigh = Math.ceil(Math.max(strategy.spot, strategy.callStrike) * 1.5);
    fields.putStrikeSlider.min = strikeRangeLow;
    fields.putStrikeSlider.max = Math.max(strikeRangeLow, strategy.callStrike - 0.5);
    fields.callStrikeSlider.min = Math.min(strikeRangeHigh, strategy.putStrike + 0.5);
    fields.callStrikeSlider.max = strikeRangeHigh;
    fields.putStrikeSlider.value = strategy.putStrike;
    fields.callStrikeSlider.value = strategy.callStrike;
    fields.contracts.value = strategy.contracts;
    const years = yearsBetween(new Date(), strategy.expiration);
    const theoreticalPut = optionPrices(strategy.spot, strategy.putStrike, years, strategy.putSigma, strategy.rate, strategy.dividend).put;
    const theoreticalCall = optionPrices(strategy.spot, strategy.callStrike, years, strategy.callSigma, strategy.rate, strategy.dividend).call;
    const premiumPerShare = strategy.putPremium + strategy.callPremium;
    const debit = premiumPerShare * 100 * strategy.contracts;
    document.getElementById("theoreticalPut").textContent = formatMoney(theoreticalPut);
    document.getElementById("strangleTheoreticalCall").textContent = formatMoney(theoreticalCall);
    document.getElementById("strangleDebit").textContent = formatMoney(debit);
    document.getElementById("lowerBreakeven").textContent = formatMoney(strategy.putStrike - premiumPerShare);
    document.getElementById("upperBreakeven").textContent = formatMoney(strategy.callStrike + premiumPerShare);
    document.getElementById("strangleMaxLoss").textContent = formatMoney(-debit);
    renderTerminal(strategy);

    const today = new Date().toISOString().slice(0, 10);
    fields.projectionDate.min = today;
    fields.projectionDate.max = fields.expiration.value;
    if (!fields.projectionDate.value || fields.projectionDate.value < today || fields.projectionDate.value > fields.expiration.value) fields.projectionDate.value = fields.expiration.value;
    fields.projectedPrice.min = Math.max(1, Math.floor(strategy.spot * 0.5));
    fields.projectedPrice.max = Math.ceil(Math.max(strategy.spot * 1.5, strategy.callStrike * 1.3));
    if (inputNumber(fields.projectedPrice) < Number(fields.projectedPrice.min) || inputNumber(fields.projectedPrice) > Number(fields.projectedPrice.max)) fields.projectedPrice.value = strategy.spot;
    updateProjection(strategy);
    fields.status.textContent = `${fields.symbol.value.trim().toUpperCase()} long strangle calculated with ${strategy.contracts} contract${strategy.contracts === 1 ? "" : "s"} per leg.`;
  } catch (error) {
    fields.status.textContent = error.message;
  }
}

function ensureFutureExpiration() {
  const expiration = new Date(`${fields.expiration.value}T16:00:00`);
  if (fields.expiration.value && expiration > new Date()) return expiration;
  const next = new Date();
  next.setDate(next.getDate() + 30);
  fields.expiration.value = next.toISOString().slice(0, 10);
  return new Date(`${fields.expiration.value}T16:00:00`);
}

function resetStrangleParameters(spot, analysis) {
  if (analysis && analysis.expiration) fields.expiration.value = analysis.expiration;
  if (analysis && Number.isFinite(analysis.volatilityProxy)) {
    fields.putVolatility.value = analysis.volatilityProxy;
    fields.callVolatility.value = analysis.volatilityProxy;
  }
  const expiration = ensureFutureExpiration();
  let nextPutStrike = analysis && Number.isFinite(analysis.stranglePutStrike)
    ? analysis.stranglePutStrike
    : Math.max(0.5, Math.round(spot * 0.98));
  let nextCallStrike = analysis && Number.isFinite(analysis.strangleCallStrike)
    ? analysis.strangleCallStrike
    : Math.max(1, Math.round(spot * 1.02));
  if (nextPutStrike >= nextCallStrike) nextCallStrike = nextPutStrike + 1;
  fields.putStrike.value = nextPutStrike.toFixed(2);
  fields.callStrike.value = nextCallStrike.toFixed(2);
  fields.projectedPrice.value = Math.round(spot);
  const years = yearsBetween(new Date(), expiration);
  const rate = inputNumber(fields.rate) / 100;
  const dividend = Math.max(0, inputNumber(fields.dividend) / 100);
  fields.putPremium.value = optionPrices(spot, nextPutStrike, years, Math.max(0.001, inputNumber(fields.putVolatility, 20) / 100), rate, dividend).put.toFixed(2);
  fields.callPremium.value = optionPrices(spot, nextCallStrike, years, Math.max(0.001, inputNumber(fields.callVolatility, 20) / 100), rate, dividend).call.toFixed(2);
}

async function loadCurrentPrice(resetParameters = false) {
  let symbol = fields.symbol.value.trim().toUpperCase();
  if (!symbol) return;
  fields.loadQuote.disabled = true;
  fields.status.textContent = `Loading current price for ${symbol}...`;
  try {
    if (window.resolveStockSymbol) symbol = await window.resolveStockSymbol(symbol);
    fields.symbol.value = symbol;
    let analysis;
    let currentPrice;
    if (resetParameters && window.loadOptionStrategyAnalysis) {
      analysis = await window.loadOptionStrategyAnalysis(symbol);
      currentPrice = Number(analysis.spot);
    } else {
      const response = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=1m`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
      currentPrice = Number(payload.candles[payload.candles.length - 1].close);
    }
    fields.spot.value = currentPrice.toFixed(2);
    terminal.state.textContent = analysis ? `Updated · RSI ${analysis.metrics.rsi}` : "Latest quote";
    if (resetParameters) resetStrangleParameters(currentPrice, analysis);
    else fields.projectedPrice.value = Math.round(currentPrice);
    recalculateStrangle();
    fields.status.textContent = resetParameters
      ? `Loaded ${symbol} at ${formatMoney(currentPrice)} and reset both strikes, projection, and model premiums. Review volatility and broker premiums.`
      : `Loaded ${symbol} at ${formatMoney(currentPrice)}. Enter current premiums and implied volatility for both legs.`;
  } catch (error) {
    fields.status.textContent = error.message;
  } finally {
    fields.loadQuote.disabled = false;
  }
}

fields.form.addEventListener("submit", (event) => { event.preventDefault(); recalculateStrangle(); });
fields.projectionDate.addEventListener("change", () => updateProjection());
fields.projectedPrice.addEventListener("input", () => updateProjection());
fields.loadQuote.addEventListener("click", () => loadCurrentPrice(false));
terminal.expirations.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-expiration]");
  if (!button) return;
  fields.expiration.value = button.dataset.expiration;
  recalculateStrangle();
});
terminal.edit.addEventListener("click", () => document.getElementById("strangleInputs").scrollIntoView({ behavior: "smooth" }));
terminal.reset.addEventListener("click", () => {
  fields.putVolatility.value = 20;
  fields.callVolatility.value = 20;
  fields.rate.value = 4.25;
  fields.dividend.value = 1.2;
  resetStrangleParameters(Math.max(0.01, inputNumber(fields.spot, 1)));
  recalculateStrangle();
  fields.status.textContent = "Strangle inputs reset around the current underlying price.";
});
fields.putStrikeSlider.addEventListener("input", () => {
  fields.putStrike.value = fields.putStrikeSlider.value;
  recalculateStrangle();
});
fields.callStrikeSlider.addEventListener("input", () => {
  fields.callStrike.value = fields.callStrikeSlider.value;
  recalculateStrangle();
});
fields.putStrike.addEventListener("input", recalculateStrangle);
fields.callStrike.addEventListener("input", recalculateStrangle);
fields.form.querySelectorAll('input[type="number"]:not(#putStrike):not(#callStrike), input[type="date"]').forEach((input) => {
  input.addEventListener("change", recalculateStrangle);
});
if (window.createStockSearch && fields.suggestions) {
  window.createStockSearch({
    input: fields.symbol,
    suggestions: fields.suggestions,
    onSelect: () => loadCurrentPrice(true)
  });
}
fields.symbol.addEventListener("change", () => loadCurrentPrice(true));
recalculateStrangle();

const strangleQueryParams = new URLSearchParams(window.location.search);
const strangleUrlSymbol = strangleQueryParams.get("symbol");
if (strangleUrlSymbol) {
  fields.symbol.value = strangleUrlSymbol.trim().toUpperCase();
  loadCurrentPrice(true);
}
