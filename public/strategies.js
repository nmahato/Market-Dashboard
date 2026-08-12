const lab = {
  symbol: document.getElementById("labSymbol"), suggestions: document.getElementById("labSymbolSuggestions"),
  type: document.getElementById("strategyType"), spot: document.getElementById("labSpot"),
  volatility: document.getElementById("labVolatility"), rate: document.getElementById("labRate"),
  dividend: document.getElementById("labDividend"), contracts: document.getElementById("labContracts"),
  analyze: document.getElementById("analyzeStrategy"), status: document.getElementById("labStatus"),
  rows: document.getElementById("strategyLegRows"), projection: document.getElementById("labProjectionDate"),
  name: document.getElementById("obStrategyName"), price: document.getElementById("obPrice"), change: document.getElementById("obChange"),
  daysToExpiry: document.getElementById("obDaysToExpiry"), monthStrip: document.getElementById("obMonthStrip"), dayStrip: document.getElementById("obDayStrip"),
  ruler: document.getElementById("obStrikeRuler"), ticks: document.getElementById("obRulerTicks"), markers: document.getElementById("obMarkers"), spotMarker: document.getElementById("spotMarker"),
  netPremiumLabel: document.getElementById("obNetPremiumLabel"), netPremium: document.getElementById("obNetPremium"),
  maxLoss: document.getElementById("obMaxLoss"), maxProfit: document.getElementById("obMaxProfit"),
  chance: document.getElementById("obChanceOfProfit"), breakevens: document.getElementById("obBreakevens"),
  tabs: document.getElementById("obTabs"), chart: document.getElementById("obChart"), table: document.getElementById("obTable"),
  dateLabel: document.getElementById("obDateLabel"), atExpiration: document.getElementById("obAtExpiration"),
  rangeSlider: document.getElementById("obRangeSlider"), rangeLabel: document.getElementById("obRangeLabel"), ivLabel: document.getElementById("obIvLabel"),
  legCount: document.getElementById("obLegCount"), legsPanel: document.getElementById("obLegsPanel"), positionsBtn: document.getElementById("obPositionsBtn"),
  advancedPanel: document.getElementById("obAdvancedPanel"), advancedBtn: document.getElementById("obAdvancedBtn"),
  historyLink: document.getElementById("obHistoricalChart"), addLegBtn: document.getElementById("obAddLegBtn"),
  saveBtn: document.getElementById("obSaveBtn"), savePanel: document.getElementById("obSavePanel"),
  saveName: document.getElementById("obSaveName"), saveConfirm: document.getElementById("obSaveConfirm"), savedList: document.getElementById("obSavedList")
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
  "long-straddle": { name: "Straddle", bias: "Large move / Long volatility", legs: [[1, "put", 1], [1, "call", 1]] },
  "long-strangle": { name: "Long Strangle", bias: "Large move / Long volatility", legs: [[1, "put", 0.98], [1, "call", 1.02]] },
  "short-straddle": { name: "Short Straddle", bias: "Range-bound / Short volatility", legs: [[-1, "put", 1], [-1, "call", 1]] },
  "short-strangle": { name: "Short Strangle", bias: "Range-bound / Short volatility", legs: [[-1, "put", 0.95], [-1, "call", 1.05]] },
  "iron-condor": { name: "Iron Condor", bias: "Range-bound / Defined risk", legs: [[1, "put", 0.9], [-1, "put", 0.95], [-1, "call", 1.05], [1, "call", 1.1]] },
  "iron-butterfly": { name: "Iron Butterfly", bias: "Pin near spot / Defined risk", legs: [[1, "put", 0.95], [-1, "put", 1], [-1, "call", 1], [1, "call", 1.05]] },
  "call-butterfly": { name: "Call Butterfly", bias: "Pin near spot / Defined risk", legs: [[1, "call", 0.95, 1], [-1, "call", 1, 2], [1, "call", 1.05, 1]] }
};

const state = { legs: [], expirations: [], expIndex: 0, activeMonthKey: null, rangePct: 30, activeTab: "table", rulerLow: 1, rulerHigh: 2, limits: null, breakevensList: [], chanceOfProfit: null };

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
function niceTicks(min, max, count) {
  if (!(max > min)) return [min];
  const rawStep = (max - min) / count; const magnitude = 10 ** Math.floor(Math.log10(rawStep)); const residual = rawStep / magnitude;
  const niceResidual = residual < 1.5 ? 1 : residual < 3 ? 2 : residual < 7 ? 5 : 10; const step = niceResidual * magnitude;
  const start = Math.ceil(min / step) * step; const ticks = [];
  for (let value = start; value <= max + step * 0.001; value += step) ticks.push(Math.round(value * 100) / 100);
  return ticks;
}

function thirdFriday(year, month) { const d = new Date(year, month, 1); d.setDate(1 + ((5 - d.getDay() + 7) % 7) + 14); return d; }
function buildExpirations() {
  const out = new Set(); const today = new Date();
  let weekly = new Date(today); weekly.setDate(weekly.getDate() + (((5 - weekly.getDay() + 7) % 7) || 7));
  for (let i = 0; i < 9; i += 1) { out.add(weekly.toISOString().slice(0, 10)); weekly = new Date(weekly); weekly.setDate(weekly.getDate() + 7); }
  for (let i = 1; i <= 15; i += 1) { const t = thirdFriday(today.getFullYear(), today.getMonth() + i); if (t > today) out.add(t.toISOString().slice(0, 10)); }
  for (let y = 2; y <= 3; y += 1) out.add(thirdFriday(today.getFullYear() + y, 11).toISOString().slice(0, 10));
  return [...out].sort().map((value) => new Date(`${value}T16:00:00`));
}
function monthKey(date) { return `${date.getFullYear()}-${date.getMonth()}`; }
function monthLabel(date) { const label = date.toLocaleDateString("en-US", { month: "short" }); return date.getFullYear() !== new Date().getFullYear() ? `${label} '${String(date.getFullYear()).slice(2)}` : label; }
function currentExpiration() { return state.expirations[state.expIndex] || new Date(); }

function settings() {
  return {
    spot: Math.max(0.01, num(lab.spot, 1)), expiration: currentExpiration(), sigma: Math.max(0.001, num(lab.volatility, 20) / 100),
    rate: num(lab.rate) / 100, dividend: Math.max(0, num(lab.dividend) / 100), units: Math.max(1, Math.floor(num(lab.contracts, 1)))
  };
}
function modelPremium(leg, config = settings()) { return leg.type === "stock" ? config.spot : optionValue(leg.type, config.spot, leg.strike, years(new Date(), config.expiration), config.sigma, config.rate, config.dividend); }
function roundedStrike(value) { return Math.max(0.5, Math.round(value * 2) / 2); }
function legResult(leg, futureSpot, date, config) {
  const multiplier = 100 * config.units * leg.ratio;
  const future = leg.type === "stock" ? futureSpot : optionValue(leg.type, futureSpot, leg.strike, years(date, config.expiration), config.sigma, config.rate, config.dividend);
  return { value: leg.side * future * multiplier, profit: leg.side * (future - leg.premium) * multiplier };
}
function positionResult(price, date, config) { return state.legs.reduce((result, leg) => { const item = legResult(leg, price, date, config); result.value += item.value; result.profit += item.profit; return result; }, { value: 0, profit: 0 }); }
function netPremiumCash(config) { return state.legs.filter((leg) => leg.type !== "stock").reduce((sum, leg) => sum - leg.side * leg.premium * leg.ratio * 100 * config.units, 0); }
function expiryProfile(config) { return Array.from({ length: 301 }, (_, index) => { const price = config.spot * 3 * index / 300; return { price, profit: positionResult(price, config.expiration, config).profit }; }); }
function breakevens(profile) {
  const roots = [];
  for (let index = 1; index < profile.length; index += 1) { const a = profile[index - 1], b = profile[index]; if (a.profit === 0) roots.push(a.price); else if ((a.profit < 0 && b.profit > 0) || (a.profit > 0 && b.profit < 0)) roots.push(a.price + (b.price - a.price) * (-a.profit / (b.profit - a.profit))); }
  return roots.filter((value, index, array) => index === 0 || Math.abs(value - array[index - 1]) > 0.5);
}
function payoffLimits(profile) { const values = profile.map((point) => point.profit); const tailSlope = values[values.length - 1] - values[values.length - 2]; return { max: tailSlope > 1 ? Infinity : Math.max(...values), min: tailSlope < -1 ? -Infinity : Math.min(...values) }; }
function chanceOfProfit(profile, config) {
  const time = years(new Date(), config.expiration);
  if (time <= 0 || config.sigma <= 0) return null;
  const mu = (config.rate - config.dividend - 0.5 * config.sigma * config.sigma) * time; const sigmaT = config.sigma * Math.sqrt(time);
  const priceCdf = (x) => (x <= 0 ? 0 : cdf((Math.log(x / config.spot) - mu) / sigmaT));
  let chance = 0;
  for (let index = 1; index < profile.length; index += 1) { const a = profile[index - 1], b = profile[index]; if ((a.profit + b.profit) / 2 > 0) chance += priceCdf(b.price) - priceCdf(a.price); }
  if (profile[0].profit > 0) chance += priceCdf(profile[0].price);
  const last = profile[profile.length - 1], prev = profile[profile.length - 2];
  if (last.profit > 0 || last.profit - prev.profit > 1) chance += 1 - priceCdf(last.price);
  return Math.min(1, Math.max(0, chance));
}

function generateLegs() {
  const config = settings(); const definition = STRATEGIES[lab.type.value] || STRATEGIES["long-straddle"];
  lab.name.innerHTML = `${definition.name} <small tabindex="0" title="Model-estimated payoff for the selected strategy.">?</small>`;
  state.legs = definition.legs.map(([side, type, factor, ratio = 1]) => {
    const leg = { side, type, ratio, strike: type === "stock" ? null : roundedStrike(config.spot * factor) };
    leg.premium = modelPremium(leg, config); return leg;
  });
  syncLegCount();
  renderLegsPanel(); renderAll();
}
function syncLegCount() { lab.legCount.textContent = state.legs.length; }
function refreshModelPremiums() { const config = settings(); state.legs.forEach((leg) => { leg.premium = modelPremium(leg, config); }); renderLegsPanel(); renderAll(); }
function renderLegsPanel() {
  lab.rows.innerHTML = state.legs.map((leg, index) => `<tr>
    <td><button type="button" class="badge ${leg.side > 0 ? "BUY_SIGNAL" : "SELL_SIGNAL"}" data-leg="${index}" data-action="toggle-side" ${leg.type === "stock" ? "disabled" : ""}>${leg.side > 0 ? "BUY" : "SELL"}${leg.ratio > 1 ? ` &times;${leg.ratio}` : ""}</button></td>
    <td>${leg.type === "stock" ? "100 shares" : `<select data-leg="${index}" data-field="type"><option value="call" ${leg.type === "call" ? "selected" : ""}>CALL</option><option value="put" ${leg.type === "put" ? "selected" : ""}>PUT</option></select>`}</td>
    <td>${leg.type === "stock" ? "&mdash;" : `<input data-leg="${index}" data-field="strike" type="number" min="0.5" step="0.5" value="${leg.strike.toFixed(2)}">`}</td>
    <td><input data-leg="${index}" data-field="premium" type="number" min="0" step="0.01" value="${leg.premium.toFixed(2)}"></td>
    <td>${leg.type === "stock" ? "Position" : currentExpiration().toLocaleDateString()}</td>
    <td><button type="button" class="ob-remove-leg" data-leg="${index}" data-action="remove" title="Remove position" ${state.legs.length <= 1 ? "disabled" : ""}>&times;</button></td>
  </tr>`).join("");
}

function renderExpirationStrips() {
  if (!state.expirations.length) return;
  const active = state.expirations[state.expIndex]; state.activeMonthKey = monthKey(active);
  const months = []; const seen = new Set();
  state.expirations.forEach((date) => { const key = monthKey(date); if (!seen.has(key)) { seen.add(key); months.push({ key, date }); } });
  lab.monthStrip.innerHTML = months.map(({ key, date }) => `<button type="button" data-month="${key}" class="${key === state.activeMonthKey ? "active" : ""}"><span>${date.getFullYear()}</span><strong>${monthLabel(date)}</strong></button>`).join("");
  const dayDates = state.expirations.map((date, index) => ({ date, index })).filter(({ date }) => monthKey(date) === state.activeMonthKey);
  lab.dayStrip.innerHTML = dayDates.map(({ date, index }) => `<button type="button" data-index="${index}" class="${index === state.expIndex ? "active" : ""}"><span>${date.toLocaleDateString("en-US", { weekday: "short" })}</span><strong>${date.getDate()}</strong></button>`).join("");
  const days = Math.max(0, Math.round((active - new Date()) / 86400000));
  lab.daysToExpiry.textContent = `${days}d`;
}
function selectExpiration(index) {
  state.expIndex = Math.max(0, Math.min(state.expirations.length - 1, index));
  lab.projection.value = 100;
  refreshModelPremiums(); renderExpirationStrips();
}

function renderStrikeRuler(config) {
  const legStrikes = state.legs.filter((leg) => leg.strike !== null).map((leg) => leg.strike);
  let low = config.spot * (1 - state.rangePct / 100); let high = config.spot * (1 + state.rangePct / 100);
  if (legStrikes.length) { low = Math.min(low, ...legStrikes.map((s) => s * 0.97)); high = Math.max(high, ...legStrikes.map((s) => s * 1.03)); }
  low = Math.max(0.5, low); state.rulerLow = low; state.rulerHigh = high;
  const ticks = niceTicks(low, high, 9);
  lab.ticks.innerHTML = ticks.map((t) => { const left = ((t - low) / (high - low) * 100).toFixed(2); return `<span style="left:${left}%">${Math.round(t)}</span><i style="left:${left}%"></i>`; }).join("");
  lab.spotMarker.style.left = `${((config.spot - low) / (high - low) * 100).toFixed(2)}%`;
  const groups = new Map();
  state.legs.forEach((leg, index) => { if (leg.strike === null) return; const key = leg.strike.toFixed(2); if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ leg, index }); });
  let html = "";
  groups.forEach((items) => {
    const strike = items[0].leg.strike; const left = ((strike - low) / (high - low) * 100).toFixed(2);
    items.forEach(({ leg, index }, stack) => {
      const top = leg.type === "call" ? -stack * 36 : 30 + stack * 36;
      html += `<div class="strike-marker ${leg.type}-marker" data-leg="${index}" style="left:${left}%; top:${top}px" title="Drag to change strike"><strong>${Math.round(strike)}${leg.type === "call" ? "C" : "P"}</strong><span>${leg.side > 0 ? "Buy" : "Sell"}</span></div>`;
    });
  });
  lab.markers.innerHTML = html;
  lab.markers.querySelectorAll(".strike-marker").forEach((el) => el.addEventListener("pointerdown", onMarkerDragStart));
}
function onMarkerDragStart(event) {
  event.preventDefault(); const index = Number(event.currentTarget.dataset.leg);
  const onMove = (moveEvent) => {
    const rect = lab.ruler.getBoundingClientRect(); const frac = Math.min(1, Math.max(0, (moveEvent.clientX - rect.left) / rect.width));
    state.legs[index].strike = roundedStrike(state.rulerLow + frac * (state.rulerHigh - state.rulerLow));
    state.legs[index].premium = modelPremium(state.legs[index]); renderLegsPanel(); renderAll();
  };
  const onUp = () => { document.removeEventListener("pointermove", onMove); document.removeEventListener("pointerup", onUp); };
  document.addEventListener("pointermove", onMove); document.addEventListener("pointerup", onUp);
}

function currentProjectionDate(config) {
  const pct = Number(lab.projection.value); const now = new Date();
  const target = now.getTime() + (pct / 100) * (config.expiration.getTime() - now.getTime());
  return new Date(Math.min(target, config.expiration.getTime()));
}
function renderDateRow(config) {
  const pct = Number(lab.projection.value); const date = currentProjectionDate(config); const atExpiry = pct >= 99.5;
  const daysOut = Math.max(0, Math.round((date - new Date()) / 86400000));
  const dateStr = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  lab.dateLabel.textContent = atExpiry ? `${dateStr} 4:00pm (${daysOut}d)` : `${dateStr} (${daysOut}d)`;
  lab.atExpiration.hidden = !atExpiry;
}

function fmtPct(value) { return `${value >= 0 ? "+" : ""}${value.toFixed(0)}%`; }
function seriesForMode(mode, config, date, low, high) {
  const points = [];
  for (let index = 0; index <= 140; index += 1) {
    const price = low + (high - low) * index / 140; const result = positionResult(price, date, config);
    let y = result.profit;
    if (mode === "contract-value") y = result.value;
    else if (mode === "pl-pct") { const basis = Math.abs(netPremiumCash(config)) || 1; y = result.profit / basis * 100; }
    else if (mode === "pct-max-risk") { const denom = state.limits && state.limits.min !== -Infinity ? Math.abs(state.limits.min) || 1 : 1; y = result.profit / denom * 100; }
    points.push({ price, y });
  }
  return points;
}
function drawChart(mode) {
  const config = settings(); const date = currentProjectionDate(config); const low = state.rulerLow, high = state.rulerHigh;
  const points = seriesForMode(mode, config, date, low, high); const ys = points.map((p) => p.y);
  let min = Math.min(...ys, 0), max = Math.max(...ys, 0); if (min === max) { min -= 1; max += 1; }
  const width = 920, height = 320, pad = { top: 34, right: 24, bottom: 34, left: 74 }; const pw = width - pad.left - pad.right, ph = height - pad.top - pad.bottom;
  const x = (v) => pad.left + (v - low) / (high - low) * pw; const y = (v) => pad.top + (max - v) / (max - min) * ph; const zeroY = y(0);
  const fmt = mode === "pl-pct" || mode === "pct-max-risk" ? fmtPct : money;
  const line = points.map((p) => `${x(p.price).toFixed(2)},${y(p.y).toFixed(2)}`).join(" ");
  const area = `${x(points[0].price).toFixed(2)},${zeroY.toFixed(2)} ${line} ${x(points[points.length - 1].price).toFixed(2)},${zeroY.toFixed(2)}`;
  const zeroFrac = ((zeroY - pad.top) / ph * 100).toFixed(1);
  const yTicks = niceTicks(min, max, 5); const xTicks = niceTicks(low, high, 6);
  const beLines = mode !== "contract-value" ? state.breakevensList.filter((v) => v >= low && v <= high).map((v) => `<line class="ob-be-line" x1="${x(v).toFixed(2)}" x2="${x(v).toFixed(2)}" y1="${pad.top}" y2="${height - pad.bottom}"></line><text class="ob-be-label" x="${x(v).toFixed(2)}" y="${pad.top - 10}" text-anchor="middle">${money(v)}</text>`).join("") : "";
  const spotX = x(config.spot).toFixed(2);
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Strategy payoff chart">
    <defs><linearGradient id="obPl" x1="0" y1="${pad.top}" x2="0" y2="${height - pad.bottom}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#22c876" stop-opacity="0.55"></stop>
      <stop offset="${zeroFrac}%" stop-color="#22c876" stop-opacity="0.08"></stop>
      <stop offset="${zeroFrac}%" stop-color="#ef4565" stop-opacity="0.08"></stop>
      <stop offset="100%" stop-color="#ef4565" stop-opacity="0.55"></stop>
    </linearGradient></defs>
    <rect class="ob-chart-bg" width="${width}" height="${height}"></rect>
    ${yTicks.map((v) => `<line class="ob-chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v).toFixed(2)}" y2="${y(v).toFixed(2)}"></line><text class="ob-chart-axis" x="${pad.left - 8}" y="${(y(v) + 4).toFixed(2)}" text-anchor="end">${fmt(v)}</text>`).join("")}
    <line class="ob-zero-line" x1="${pad.left}" x2="${width - pad.right}" y1="${zeroY.toFixed(2)}" y2="${zeroY.toFixed(2)}"></line>
    <polygon class="ob-area" points="${area}" fill="url(#obPl)"></polygon>
    <polyline class="ob-line" points="${line}"></polyline>
    <line class="ob-spot-line" x1="${spotX}" x2="${spotX}" y1="${pad.top}" y2="${height - pad.bottom}"></line>
    ${beLines}
    ${xTicks.map((v) => `<text class="ob-chart-axis" x="${x(v).toFixed(2)}" y="${height - 10}" text-anchor="middle">${money(v)}</text>`).join("")}
  </svg>`;
}
function renderTable() {
  const config = settings(); const date = currentProjectionDate(config); const low = state.rulerLow, high = state.rulerHigh;
  const cash = netPremiumCash(config); const plBasis = Math.abs(cash) || 1; const riskBasis = state.limits && state.limits.min !== -Infinity ? Math.abs(state.limits.min) || 1 : 1;
  const rows = Array.from({ length: 25 }, (_, index) => low + (high - low) * index / 24);
  lab.table.innerHTML = `<table><thead><tr><th>Stock Price</th><th>P/L $</th><th>P/L %</th><th>Contract Value</th><th>% of Max Risk</th></tr></thead><tbody>${rows.map((price) => {
    const result = positionResult(price, date, config); const cls = result.profit >= 0 ? "positive" : "negative"; const isCurrent = Math.abs(price - config.spot) < (high - low) / 48;
    return `<tr class="${isCurrent ? "ob-row-current" : ""}"><td>${money(price)}</td><td class="${cls}">${money(result.profit)}</td><td class="${cls}">${fmtPct(result.profit / plBasis * 100)}</td><td>${money(result.value)}</td><td class="${cls}">${fmtPct(result.profit / riskBasis * 100)}</td></tr>`;
  }).join("")}</tbody></table>`;
}
function renderActiveTab() {
  lab.tabs.querySelectorAll("button").forEach((button) => button.classList.toggle("active", button.dataset.tab === state.activeTab));
  if (state.activeTab === "table") { lab.table.hidden = false; lab.chart.hidden = true; renderTable(); return; }
  lab.table.hidden = true; lab.chart.hidden = false; lab.chart.innerHTML = drawChart(state.activeTab === "graph" ? "pl-dollar" : state.activeTab);
}

function renderMetrics(config) {
  const cash = netPremiumCash(config); lab.netPremiumLabel.textContent = cash >= 0 ? "Net Credit" : "Net Debit"; lab.netPremium.textContent = money(Math.abs(cash));
  const profile = expiryProfile(config); state.limits = payoffLimits(profile); state.breakevensList = breakevens(profile); state.chanceOfProfit = chanceOfProfit(profile, config);
  lab.maxLoss.textContent = state.limits.min === -Infinity ? "Unlimited" : money(state.limits.min); lab.maxLoss.className = "negative";
  lab.maxProfit.textContent = state.limits.max === Infinity ? "Unlimited" : money(state.limits.max); lab.maxProfit.className = "positive";
  lab.chance.textContent = state.chanceOfProfit === null ? "--" : `${Math.round(state.chanceOfProfit * 100)}%`;
  lab.breakevens.textContent = state.breakevensList.length ? state.breakevensList.map(money).join(" / ") : "None in range";
}
function renderQuote(config) { lab.price.textContent = money(config.spot); }

function renderAll() {
  if (!state.legs.length) return;
  const config = settings();
  renderQuote(config); renderMetrics(config); renderStrikeRuler(config); renderDateRow(config); renderActiveTab();
  lab.rangeLabel.textContent = `±${state.rangePct}%`; lab.ivLabel.textContent = `${num(lab.volatility, 20).toFixed(1)}%`;
  lab.historyLink.href = `/chart.html?symbol=${encodeURIComponent(lab.symbol.value.trim().toUpperCase() || "SPY")}`;
}

const SAVED_TRADES_KEY = "marketRsiSavedTrades";
function loadSavedTrades() { try { return JSON.parse(localStorage.getItem(SAVED_TRADES_KEY)) || []; } catch { return []; } }
function persistSavedTrades(list) { localStorage.setItem(SAVED_TRADES_KEY, JSON.stringify(list)); }
function renderSavedTrades() {
  const list = loadSavedTrades();
  lab.savedList.innerHTML = list.length ? list.map((trade, index) => `<li>
    <button type="button" class="ob-saved-open" data-index="${index}">${trade.name}<span>${trade.symbol} &middot; ${trade.strategyLabel}</span></button>
    <button type="button" class="ob-saved-delete" data-index="${index}" title="Delete saved trade">&times;</button>
  </li>`).join("") : `<li class="ob-saved-empty">No saved trades yet.</li>`;
}
function captureTradeSnapshot(name) {
  const config = settings();
  return {
    name, symbol: lab.symbol.value.trim().toUpperCase() || "SPY", strategy: lab.type.value,
    strategyLabel: (STRATEGIES[lab.type.value] || {}).name || lab.type.value,
    spot: config.spot, volatility: num(lab.volatility, 20), rate: num(lab.rate), dividend: num(lab.dividend), contracts: config.units,
    expIndex: state.expIndex, rangePct: state.rangePct,
    legs: state.legs.map((leg) => ({ side: leg.side, type: leg.type, ratio: leg.ratio, strike: leg.strike, premium: leg.premium }))
  };
}
function applyTradeSnapshot(trade) {
  lab.symbol.value = trade.symbol; if (STRATEGIES[trade.strategy]) lab.type.value = trade.strategy;
  lab.spot.value = trade.spot; lab.volatility.value = trade.volatility; lab.rate.value = trade.rate; lab.dividend.value = trade.dividend; lab.contracts.value = trade.contracts;
  state.expIndex = Math.max(0, Math.min(state.expirations.length - 1, trade.expIndex || 0));
  state.rangePct = trade.rangePct || 30; lab.rangeSlider.value = state.rangePct;
  state.legs = trade.legs.map((leg) => ({ ...leg }));
  syncLegCount(); renderLegsPanel(); renderExpirationStrips(); renderAll();
  lab.status.textContent = `Loaded saved trade "${trade.name}".`;
}

async function analyzeUnderlying() {
  let symbol = lab.symbol.value.trim().toUpperCase(); if (!symbol) return; lab.analyze.disabled = true; lab.status.textContent = `Analyzing ${symbol}...`;
  try {
    if (window.resolveStockSymbol) symbol = await window.resolveStockSymbol(symbol); lab.symbol.value = symbol;
    const analysis = await window.loadOptionStrategyAnalysis(symbol);
    lab.spot.value = analysis.spot; lab.volatility.value = Math.min(150, Math.max(1, analysis.volatilityProxy));
    if (STRATEGIES[analysis.recommendation]) lab.type.value = analysis.recommendation;
    const change = analysis.metrics && Number.isFinite(analysis.metrics.return20);
    lab.change.textContent = change ? `${analysis.metrics.return20 >= 0 ? "+" : ""}${analysis.metrics.return20}% (20d)` : "--";
    lab.change.className = `ob-change ${change && analysis.metrics.return20 >= 0 ? "positive" : "negative"}`;
    generateLegs();
    lab.status.textContent = analysis.recommendation === "wait" ? `${symbol}: no clean setup now. The model recommends waiting rather than forcing an options trade.` : `${symbol}: ${STRATEGIES[lab.type.value].name} is the best current model fit and has been loaded below. Review every leg before use.`;
  } catch (error) { lab.status.textContent = error.message; } finally { lab.analyze.disabled = false; }
}

Object.entries(STRATEGIES).forEach(([value, item]) => lab.type.add(new Option(item.name, value)));
const requested = new URLSearchParams(location.search).get("strategy"); lab.type.value = STRATEGIES[requested] ? requested : "long-straddle";
state.expirations = buildExpirations();
state.expIndex = state.expirations.reduce((best, date, index) => Math.abs(date - Date.now() - 30 * 86400000) < Math.abs(state.expirations[best] - Date.now() - 30 * 86400000) ? index : best, 0);
renderExpirationStrips();

lab.type.addEventListener("change", generateLegs);
lab.analyze.addEventListener("click", analyzeUnderlying);
lab.symbol.addEventListener("change", analyzeUnderlying);
lab.projection.addEventListener("input", renderAll);
lab.rangeSlider.addEventListener("input", () => { state.rangePct = Number(lab.rangeSlider.value); renderAll(); });
[lab.spot, lab.rate, lab.dividend, lab.contracts].forEach((input) => input.addEventListener("change", refreshModelPremiums));
lab.volatility.addEventListener("input", refreshModelPremiums);
lab.rows.addEventListener("change", (event) => {
  const field = event.target.closest("[data-leg]"); if (!field) return; const leg = state.legs[Number(field.dataset.leg)]; if (!leg) return;
  if (field.dataset.field === "strike") { leg.strike = Math.max(0.5, Number(field.value)); leg.premium = modelPremium(leg); renderLegsPanel(); }
  else if (field.dataset.field === "type") { leg.type = field.value; leg.premium = modelPremium(leg); renderLegsPanel(); }
  else leg.premium = Math.max(0, Number(field.value));
  renderAll();
});
lab.rows.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]"); if (!button) return; const index = Number(button.dataset.leg); const leg = state.legs[index]; if (!leg) return;
  if (button.dataset.action === "toggle-side") leg.side = leg.side > 0 ? -1 : 1;
  else if (button.dataset.action === "remove" && state.legs.length > 1) state.legs.splice(index, 1);
  syncLegCount(); renderLegsPanel(); renderAll();
});
lab.addLegBtn.addEventListener("click", () => {
  const config = settings(); const strike = roundedStrike(config.spot); const leg = { side: 1, type: "call", ratio: 1, strike };
  leg.premium = modelPremium(leg, config); state.legs.push(leg);
  lab.legsPanel.hidden = false; syncLegCount(); renderLegsPanel(); renderAll();
});
lab.tabs.addEventListener("click", (event) => { const button = event.target.closest("button[data-tab]"); if (!button) return; state.activeTab = button.dataset.tab; renderActiveTab(); });
lab.monthStrip.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-month]"); if (!button) return;
  const index = state.expirations.findIndex((date) => monthKey(date) === button.dataset.month);
  if (index >= 0) selectExpiration(index);
});
lab.dayStrip.addEventListener("click", (event) => { const button = event.target.closest("button[data-index]"); if (!button) return; selectExpiration(Number(button.dataset.index)); });
lab.positionsBtn.addEventListener("click", () => { lab.legsPanel.hidden = !lab.legsPanel.hidden; });
lab.advancedBtn.addEventListener("click", () => { lab.advancedPanel.hidden = !lab.advancedPanel.hidden; });
lab.saveBtn.addEventListener("click", () => { lab.savePanel.hidden = !lab.savePanel.hidden; if (!lab.savePanel.hidden) renderSavedTrades(); });
lab.saveConfirm.addEventListener("click", () => {
  const name = lab.saveName.value.trim(); if (!name) { lab.saveName.focus(); return; }
  const list = loadSavedTrades(); list.push(captureTradeSnapshot(name)); persistSavedTrades(list);
  lab.saveName.value = ""; renderSavedTrades(); lab.status.textContent = `Saved trade "${name}".`;
});
lab.savedList.addEventListener("click", (event) => {
  const openBtn = event.target.closest(".ob-saved-open"); const deleteBtn = event.target.closest(".ob-saved-delete");
  if (openBtn) { const trade = loadSavedTrades()[Number(openBtn.dataset.index)]; if (trade) applyTradeSnapshot(trade); }
  else if (deleteBtn) { const list = loadSavedTrades(); list.splice(Number(deleteBtn.dataset.index), 1); persistSavedTrades(list); renderSavedTrades(); }
});
if (window.createStockSearch && lab.suggestions) window.createStockSearch({ input: lab.symbol, suggestions: lab.suggestions, onSelect: analyzeUnderlying });

generateLegs();
analyzeUnderlying();
