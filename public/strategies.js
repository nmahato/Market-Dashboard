const lab = {
  form: document.getElementById("strategyLabForm"), symbol: document.getElementById("labSymbol"),
  suggestions: document.getElementById("labSymbolSuggestions"), type: document.getElementById("strategyType"),
  spot: document.getElementById("labSpot"), expiration: document.getElementById("labExpiration"),
  volatility: document.getElementById("labVolatility"), rate: document.getElementById("labRate"),
  dividend: document.getElementById("labDividend"), contracts: document.getElementById("labContracts"),
  analyze: document.getElementById("analyzeStrategy"), status: document.getElementById("labStatus"),
  rows: document.getElementById("strategyLegRows"), projectionDate: document.getElementById("labProjectionDate"),
  projectedPrice: document.getElementById("labProjectedPrice"), projectedPriceValue: document.getElementById("labProjectedPriceValue"),
  catalogRows: document.getElementById("strategyCatalogRows"), catalogCount: document.getElementById("strategyCatalogCount")
};

const STRATEGIES = {
  "long-call": { name: "Long Call", bias: "Bullish", legs: [[1, "call", 1]] },
  "long-put": { name: "Long Put", bias: "Bearish", legs: [[1, "put", 1]] },
  "covered-call": { name: "Covered Call", bias: "Neutral / Bullish", legs: [[1, "stock", 1], [-1, "call", 1.05]] },
  "protective-put": { name: "Protective Put", bias: "Bullish with protection", legs: [[1, "stock", 1], [1, "put", 0.95]] },
  collar: { name: "Collar", bias: "Protected / Capped", legs: [[1, "stock", 1], [1, "put", 0.95], [-1, "call", 1.05]] },
  "cash-secured-put": { name: "Cash-Secured Put", bias: "Neutral / Bullish", legs: [[-1, "put", 0.95]] },
  "bull-call-spread": { name: "Bull Call Spread", bias: "Bullish", legs: [[1, "call", 1], [-1, "call", 1.05]] },
  "bear-put-spread": { name: "Bear Put Spread", bias: "Bearish", legs: [[1, "put", 1], [-1, "put", 0.95]] },
  "bull-put-spread": { name: "Bull Put Spread", bias: "Neutral / Bullish", legs: [[1, "put", 0.9], [-1, "put", 0.95]] },
  "bear-call-spread": { name: "Bear Call Spread", bias: "Neutral / Bearish", legs: [[-1, "call", 1.05], [1, "call", 1.1]] },
  "long-straddle": { name: "Long Straddle", bias: "Large move / Long volatility", legs: [[1, "put", 1], [1, "call", 1]] },
  "long-strangle": { name: "Long Strangle", bias: "Large move / Long volatility", legs: [[1, "put", 0.98], [1, "call", 1.02]] },
  "short-straddle": { name: "Short Straddle", bias: "Range-bound / Short volatility", legs: [[-1, "put", 1], [-1, "call", 1]] },
  "short-strangle": { name: "Short Strangle", bias: "Range-bound / Short volatility", legs: [[-1, "put", 0.95], [-1, "call", 1.05]] },
  "iron-condor": { name: "Iron Condor", bias: "Range-bound / Defined risk", legs: [[1, "put", 0.9], [-1, "put", 0.95], [-1, "call", 1.05], [1, "call", 1.1]] },
  "iron-butterfly": { name: "Iron Butterfly", bias: "Pin near spot / Defined risk", legs: [[1, "put", 0.95], [-1, "put", 1], [-1, "call", 1], [1, "call", 1.05]] },
  "call-butterfly": { name: "Call Butterfly", bias: "Pin near spot / Defined risk", legs: [[1, "call", 0.95, 1], [-1, "call", 1, 2], [1, "call", 1.05, 1]] }
};

let legs = [];
function legLabel([side, type, , ratio = 1]) {
  const amount = type === "stock" ? `${100 * ratio} shares` : `${ratio > 1 ? `${ratio} ` : ""}${type}`;
  return `${side > 0 ? "Buy" : "Sell"} ${amount}`;
}
function renderStrategyCatalog() {
  const entries = Object.entries(STRATEGIES);
  lab.catalogRows.innerHTML = entries.map(([key, strategy]) => `<tr data-strategy="${key}">
    <td><strong>${strategy.name}</strong></td>
    <td><span class="strategy-outlook">${strategy.bias}</span></td>
    <td>${strategy.legs.map(legLabel).join(" + ")}</td>
    <td><button type="button" class="strategy-open-btn" data-open-strategy="${key}">Open</button></td>
  </tr>`).join("");
  lab.catalogCount.textContent = `${entries.length} strategies`;
}
function markBestStrategy(strategyKey, confidence) {
  lab.catalogRows.querySelectorAll("tr[data-strategy]").forEach((row) => {
    const isBest = row.dataset.strategy === strategyKey;
    row.classList.toggle("strategy-best-now", isBest);
    const name = row.querySelector("td:first-child");
    const oldBadge = name.querySelector(".best-now-badge");
    if (oldBadge) oldBadge.remove();
    if (isBest) name.insertAdjacentHTML("beforeend", `<span class="best-now-badge">Best now · ${confidence}%</span>`);
  });
}
function num(input, fallback = 0) { const value = Number(input.value); return Number.isFinite(value) ? value : fallback; }
function money(value) { return Number.isFinite(value) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value) : "--"; }
function cdf(value) { const sign = value < 0 ? -1 : 1; const x = Math.abs(value) / Math.sqrt(2); const t = 1 / (1 + 0.3275911 * x); const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return 0.5 * (1 + sign * erf); }
function years(from, to) { return Math.max(0, (to - from) / (365.25 * 86400000)); }
function optionValue(type, spot, strike, time, sigma, rate, dividend) {
  if (time <= 0 || sigma <= 0) return type === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const root = Math.sqrt(time); const d1 = (Math.log(spot / strike) + (rate - dividend + sigma * sigma / 2) * time) / (sigma * root); const d2 = d1 - sigma * root;
  return type === "call"
    ? spot * Math.exp(-dividend * time) * cdf(d1) - strike * Math.exp(-rate * time) * cdf(d2)
    : strike * Math.exp(-rate * time) * cdf(-d2) - spot * Math.exp(-dividend * time) * cdf(-d1);
}
function settings() {
  return { spot: Math.max(0.01, num(lab.spot, 1)), expiration: new Date(`${lab.expiration.value}T16:00:00`), sigma: Math.max(0.001, num(lab.volatility, 20) / 100), rate: num(lab.rate) / 100, dividend: Math.max(0, num(lab.dividend) / 100), units: Math.max(1, Math.floor(num(lab.contracts, 1))) };
}
function modelPremium(leg, config = settings()) { return leg.type === "stock" ? config.spot : optionValue(leg.type, config.spot, leg.strike, years(new Date(), config.expiration), config.sigma, config.rate, config.dividend); }
function roundedStrike(value) { return Math.max(0.5, Math.round(value)); }

function generateLegs() {
  const config = settings(); const definition = STRATEGIES[lab.type.value] || STRATEGIES["covered-call"];
  legs = definition.legs.map(([side, type, factor, ratio = 1]) => {
    const leg = { side, type, ratio, strike: type === "stock" ? null : roundedStrike(config.spot * factor) };
    leg.premium = modelPremium(leg, config); return leg;
  });
  renderLegs(); calculate();
}
function refreshModelPremiums() { const config = settings(); legs.forEach((leg) => { leg.premium = modelPremium(leg, config); }); renderLegs(); calculate(); }
function renderLegs() {
  lab.rows.innerHTML = legs.map((leg, index) => `<tr><td><span class="badge ${leg.side > 0 ? "BUY_SIGNAL" : "SELL_SIGNAL"}">${leg.side > 0 ? "BUY" : "SELL"}${leg.ratio > 1 ? ` ×${leg.ratio}` : ""}</span></td><td>${leg.type === "stock" ? "100 shares" : leg.type.toUpperCase()}</td><td>${leg.type === "stock" ? "—" : `<input data-leg="${index}" data-field="strike" type="number" min="0.5" step="0.5" value="${leg.strike.toFixed(2)}">`}</td><td><input data-leg="${index}" data-field="premium" type="number" min="0" step="0.01" value="${leg.premium.toFixed(2)}"></td><td>${leg.type === "stock" ? "Position" : lab.expiration.value}</td></tr>`).join("");
}
function legResult(leg, futureSpot, date, config) {
  const multiplier = 100 * config.units * leg.ratio;
  const future = leg.type === "stock" ? futureSpot : optionValue(leg.type, futureSpot, leg.strike, years(date, config.expiration), config.sigma, config.rate, config.dividend);
  return { value: leg.side * future * multiplier, profit: leg.side * (future - leg.premium) * multiplier };
}
function positionResult(price, date, config = settings()) { return legs.reduce((result, leg) => { const item = legResult(leg, price, date, config); result.value += item.value; result.profit += item.profit; return result; }, { value: 0, profit: 0 }); }
function expiryProfile(config) { return Array.from({ length: 301 }, (_, index) => { const price = config.spot * 3 * index / 300; return { price, profit: positionResult(price, config.expiration, config).profit }; }); }
function breakevens(profile) {
  const roots = [];
  for (let index = 1; index < profile.length; index += 1) { const a = profile[index - 1], b = profile[index]; if (a.profit === 0) roots.push(a.price); else if ((a.profit < 0 && b.profit > 0) || (a.profit > 0 && b.profit < 0)) roots.push(a.price + (b.price - a.price) * (-a.profit / (b.profit - a.profit))); }
  return roots.filter((value, index, array) => index === 0 || Math.abs(value - array[index - 1]) > 0.5);
}
function payoffLimits(profile) { const values = profile.map((point) => point.profit); const tailSlope = values[values.length - 1] - values[values.length - 2]; return { max: tailSlope > 1 ? Infinity : Math.max(...values), min: tailSlope < -1 ? -Infinity : Math.min(...values) }; }

function chart(config, date) {
  const width = 980, height = 360, pad = { top: 24, right: 30, bottom: 42, left: 72 }; const low = Math.max(0.01, config.spot * 0.45), high = config.spot * 1.6;
  const points = Array.from({ length: 101 }, (_, i) => { const price = low + (high - low) * i / 100; return { price, profit: positionResult(price, date, config).profit }; });
  const profits = points.map((p) => p.profit), min = Math.min(...profits, 0), max = Math.max(...profits, 0), range = max - min || 1, pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
  const x = (v) => pad.left + (v - low) / (high - low) * pw, y = (v) => pad.top + (max - v) / range * ph, zero = y(0), line = points.map((p) => `${x(p.price).toFixed(2)},${y(p.profit).toFixed(2)}`).join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Strategy profit and loss projection"><rect class="option-chart-bg" width="${width}" height="${height}"></rect>${Array.from({ length: 5 }, (_, i) => { const v = max - range * i / 4; return `<line class="option-chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"></line><text class="option-chart-axis" x="${pad.left - 10}" y="${y(v) + 4}" text-anchor="end">${money(v)}</text>`; }).join("")}<rect class="option-loss-zone" x="${pad.left}" y="${zero}" width="${pw}" height="${Math.max(0, height - pad.bottom - zero)}"></rect><line class="option-zero-line" x1="${pad.left}" x2="${width - pad.right}" y1="${zero}" y2="${zero}"></line><polyline class="option-profit-line" points="${line}"></polyline>${Array.from({ length: 6 }, (_, i) => { const v = low + (high - low) * i / 5; return `<text class="option-chart-axis" x="${x(v)}" y="${height - 14}" text-anchor="middle">${money(v)}</text>`; }).join("")}</svg>`;
}
function calculate() {
  if (!legs.length) return; const config = settings(); const date = new Date(`${lab.projectionDate.value || lab.expiration.value}T16:00:00`); const projected = num(lab.projectedPrice, config.spot); const result = positionResult(projected, date, config);
  const optionCash = legs.filter((leg) => leg.type !== "stock").reduce((sum, leg) => sum - leg.side * leg.premium * leg.ratio * 100 * config.units, 0); const profile = expiryProfile(config), limits = payoffLimits(profile), roots = breakevens(profile);
  document.getElementById("labNetPremium").textContent = `${optionCash >= 0 ? "Credit" : "Debit"} ${money(Math.abs(optionCash))}`; document.getElementById("labMaxProfit").textContent = limits.max === Infinity ? "Unlimited" : money(limits.max); document.getElementById("labMaxLoss").textContent = limits.min === -Infinity ? "Unlimited" : money(limits.min); document.getElementById("labBreakevens").textContent = roots.length ? roots.map(money).join(" / ") : "None in range"; document.getElementById("labBias").textContent = STRATEGIES[lab.type.value].bias;
  lab.projectedPriceValue.textContent = money(projected); document.getElementById("labPositionValue").textContent = money(result.value); const profit = document.getElementById("labProjectedProfit"); profit.textContent = money(result.profit); profit.className = result.profit >= 0 ? "positive" : "negative"; document.getElementById("strategyPayoffChart").innerHTML = chart(config, date);
}

async function analyzeUnderlying() {
  let symbol = lab.symbol.value.trim().toUpperCase(); if (!symbol) return; lab.analyze.disabled = true; lab.status.textContent = `Analyzing ${symbol}...`;
  try { if (window.resolveStockSymbol) symbol = await window.resolveStockSymbol(symbol); lab.symbol.value = symbol; const analysis = await window.loadOptionStrategyAnalysis(symbol); lab.spot.value = analysis.spot; lab.expiration.value = analysis.expiration; lab.volatility.value = analysis.volatilityProxy; markBestStrategy(analysis.recommendation, analysis.confidence); if (STRATEGIES[analysis.recommendation]) lab.type.value = analysis.recommendation; lab.projectionDate.min = new Date().toISOString().slice(0, 10); lab.projectionDate.max = analysis.expiration; lab.projectionDate.value = analysis.expiration; lab.projectedPrice.min = Math.max(1, Math.floor(analysis.spot * 0.45)); lab.projectedPrice.max = Math.ceil(analysis.spot * 1.6); lab.projectedPrice.value = analysis.spot; generateLegs(); lab.status.textContent = analysis.recommendation === "wait" ? `${symbol}: no clean setup now. The model recommends waiting rather than forcing an options trade.` : `${symbol}: ${STRATEGIES[lab.type.value].name} is the best current model fit and has been loaded below. Review every leg before use.`; }
  catch (error) { lab.status.textContent = error.message; } finally { lab.analyze.disabled = false; }
}

Object.entries(STRATEGIES).forEach(([value, item]) => lab.type.add(new Option(item.name, value)));
renderStrategyCatalog();
const requested = new URLSearchParams(location.search).get("strategy"); lab.type.value = STRATEGIES[requested] ? requested : "covered-call";
const defaultExpiry = new Date(); defaultExpiry.setDate(defaultExpiry.getDate() + 45); lab.expiration.value = defaultExpiry.toISOString().slice(0, 10); lab.projectionDate.value = lab.expiration.value;
lab.form.addEventListener("submit", (event) => { event.preventDefault(); calculate(); }); lab.type.addEventListener("change", generateLegs); lab.analyze.addEventListener("click", analyzeUnderlying); lab.projectedPrice.addEventListener("input", calculate); lab.projectionDate.addEventListener("change", calculate); lab.contracts.addEventListener("change", calculate);
[lab.spot, lab.expiration, lab.volatility, lab.rate, lab.dividend].forEach((input) => input.addEventListener("change", refreshModelPremiums));
lab.rows.addEventListener("change", (event) => { const input = event.target.closest("input[data-leg]"); if (!input) return; const leg = legs[Number(input.dataset.leg)]; if (input.dataset.field === "strike") { leg.strike = Math.max(0.5, Number(input.value)); leg.premium = modelPremium(leg); renderLegs(); } else leg.premium = Math.max(0, Number(input.value)); calculate(); });
lab.catalogRows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-strategy]"); if (!button) return;
  lab.type.value = button.dataset.openStrategy; generateLegs();
  document.querySelector(".strategy-lab-controls").scrollIntoView({ behavior: "smooth", block: "start" });
});
if (window.createStockSearch && lab.suggestions) window.createStockSearch({ input: lab.symbol, suggestions: lab.suggestions, onSelect: analyzeUnderlying }); lab.symbol.addEventListener("change", analyzeUnderlying);
generateLegs(); analyzeUnderlying();
