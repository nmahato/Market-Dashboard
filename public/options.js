const chainSymbolInput = document.getElementById("chainSymbolInput");
const chainSymbolSuggestions = document.getElementById("chainSymbolSuggestions");
const chainSymbol = document.getElementById("chainSymbol");
const chainPrice = document.getElementById("chainPrice");
const chainChange = document.getElementById("chainChange");
const chainHistoryLink = document.getElementById("chainHistoryLink");
const chainBuilderLink = document.getElementById("chainBuilderLink");
const chainTitle = document.getElementById("chainTitle");
const chainExpirationSelect = document.getElementById("chainExpirationSelect");
const chainPriceColumnHeader = document.getElementById("chainPriceColumnHeader");
const chainRows = document.getElementById("chainRows");
const chainStatus = document.getElementById("chainStatus");
const sideButtons = Array.from(document.querySelectorAll(".chain-seg-btn[data-side]"));
const typeButtons = Array.from(document.querySelectorAll(".chain-seg-btn[data-type]"));

let currentChain = null;
let currentSide = "buy";
let currentType = "call";
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

function money(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSignedMoney(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${money(value)}`;
}

function changeClass(value) {
  if (!Number.isFinite(value)) return "neutral";
  return value >= 0 ? "positive" : "negative";
}

function formatExpirationLabel(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const today = new Date();
  const days = Math.max(0, Math.round((date - new Date(today.toDateString())) / 86400000));
  const label = date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `Expiring ${label} (${days}d)`;
}

function updateHeader() {
  if (!currentChain) return;
  const symbol = currentChain.symbol;
  chainSymbol.textContent = symbol;
  chainPrice.textContent = money(currentChain.price);
  const change = currentChain.change;
  const changePercent = currentChain.changePercent;
  chainChange.textContent = Number.isFinite(change) && Number.isFinite(changePercent)
    ? `${formatSignedMoney(change)} (${formatPercent(changePercent)})`
    : "--";
  chainChange.className = `chain-change ${changeClass(change)}`;
  chainHistoryLink.href = `/indicator.html?symbol=${encodeURIComponent(symbol)}`;
  chainBuilderLink.href = `/strategies.html?symbol=${encodeURIComponent(symbol)}`;
  chainTitle.textContent = `${symbol} ${currentSide} ${currentType === "call" ? "Call" : "Put"}`;
  chainPriceColumnHeader.textContent = currentSide === "buy" ? "Ask Price" : "Bid Price";
}

function updateExpirationOptions() {
  if (!currentChain) return;
  const dates = currentChain.expirationDates;
  chainExpirationSelect.innerHTML = dates.map((timestamp) => `
    <option value="${timestamp}" ${timestamp === currentChain.selectedExpiration ? "selected" : ""}>
      ${escapeHtml(formatExpirationLabel(timestamp))}
    </option>
  `).join("");
}

const STRIKES_EACH_SIDE = 10;

function nearTheMoneyWindow(sorted, currentPrice) {
  if (!Number.isFinite(currentPrice)) return sorted;
  const splitIndex = sorted.findIndex((contract) => contract.strike < currentPrice);
  const aboveStart = splitIndex === -1 ? Math.max(0, sorted.length - STRIKES_EACH_SIDE) : Math.max(0, splitIndex - STRIKES_EACH_SIDE);
  const belowEnd = splitIndex === -1 ? sorted.length : Math.min(sorted.length, splitIndex + STRIKES_EACH_SIDE);
  return sorted.slice(aboveStart, belowEnd);
}

function renderRows() {
  if (!currentChain) return;
  const contracts = currentType === "call" ? currentChain.calls : currentChain.puts;
  const currentPrice = currentChain.price;
  const sortedFull = [...contracts].filter((contract) => Number.isFinite(contract.strike)).sort((a, b) => b.strike - a.strike);
  const sorted = nearTheMoneyWindow(sortedFull, currentPrice);

  if (!sorted.length) {
    chainRows.innerHTML = '<tr><td colspan="6" class="loading">No contracts available for this expiration.</td></tr>';
    return;
  }

  const rowsHtml = [];
  let dividerInserted = false;

  sorted.forEach((contract) => {
    if (!dividerInserted && Number.isFinite(currentPrice) && contract.strike < currentPrice) {
      rowsHtml.push(dividerRowMarkup(currentPrice));
      dividerInserted = true;
    }
    rowsHtml.push(contractRowMarkup(contract, currentPrice));
  });

  if (!dividerInserted && Number.isFinite(currentPrice)) {
    rowsHtml.push(dividerRowMarkup(currentPrice));
  }

  chainRows.innerHTML = rowsHtml.join("");
}

function dividerRowMarkup(currentPrice) {
  return `
    <tr class="chain-divider-row">
      <td colspan="6"><span class="chain-divider-pill">Share price: ${escapeHtml(money(currentPrice))}</span></td>
    </tr>
  `;
}

function contractRowMarkup(contract, currentPrice) {
  const priceField = currentSide === "buy" ? contract.ask : contract.bid;
  const breakeven = Number.isFinite(priceField)
    ? (currentType === "call" ? contract.strike + priceField : contract.strike - priceField)
    : null;
  const toBreakevenPercent = Number.isFinite(breakeven) && Number.isFinite(currentPrice) && currentPrice !== 0
    ? ((breakeven - currentPrice) / currentPrice) * 100
    : null;
  const inTheMoney = currentType === "call"
    ? Number.isFinite(currentPrice) && contract.strike < currentPrice
    : Number.isFinite(currentPrice) && contract.strike > currentPrice;

  return `
    <tr>
      <td class="chain-strike">${money(contract.strike)}${inTheMoney ? '<span class="chain-itm-tag">ITM</span>' : ""}</td>
      <td>${money(breakeven)}</td>
      <td class="chain-change-cell ${changeClass(toBreakevenPercent)}">${formatPercent(toBreakevenPercent)}</td>
      <td class="chain-change-cell ${changeClass(contract.percentChange)}">${formatPercent(contract.percentChange)}</td>
      <td class="chain-change-cell ${changeClass(contract.change)}">${formatSignedMoney(contract.change)}</td>
      <td><span class="chain-price-pill ${changeClass(contract.change) === "negative" ? "negative" : ""}">${Number.isFinite(priceField) ? money(priceField) : "--"}</span></td>
    </tr>
  `;
}

function renderAll() {
  updateHeader();
  updateExpirationOptions();
  renderRows();
}

async function loadChain(symbolValue, expirationValue) {
  if (isLoading) return;
  isLoading = true;
  chainStatus.textContent = `Loading option chain for ${symbolValue}...`;
  try {
    const params = new URLSearchParams({ symbol: symbolValue });
    if (expirationValue) params.set("expiration", expirationValue);
    const response = await fetch(`/api/option-chain?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    currentChain = payload;
    renderAll();
    chainStatus.textContent = `${payload.symbol}: ${payload.calls.length} calls, ${payload.puts.length} puts. Data from Yahoo Finance, may be delayed.`;
  } catch (error) {
    chainStatus.textContent = error.message;
    chainRows.innerHTML = `<tr><td colspan="6" class="loading">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    isLoading = false;
  }
}

function setSide(side) {
  currentSide = side;
  sideButtons.forEach((button) => button.classList.toggle("active", button.dataset.side === side));
  renderAll();
}

function setType(type) {
  currentType = type;
  typeButtons.forEach((button) => button.classList.toggle("active", button.dataset.type === type));
  renderAll();
}

sideButtons.forEach((button) => {
  button.addEventListener("click", () => setSide(button.dataset.side));
});

typeButtons.forEach((button) => {
  button.addEventListener("click", () => setType(button.dataset.type));
});

chainExpirationSelect.addEventListener("change", () => {
  loadChain(chainSymbolInput.value.trim().toUpperCase(), chainExpirationSelect.value);
});

async function handleSymbolChange() {
  let symbol = chainSymbolInput.value.trim().toUpperCase();
  if (!symbol) return;
  if (window.resolveStockSymbol) symbol = await window.resolveStockSymbol(symbol);
  chainSymbolInput.value = symbol;
  loadChain(symbol);
}

chainSymbolInput.addEventListener("change", handleSymbolChange);

if (window.createStockSearch && chainSymbolSuggestions) {
  window.createStockSearch({
    input: chainSymbolInput,
    suggestions: chainSymbolSuggestions,
    onSelect: () => handleSymbolChange()
  });
}

const initialParams = new URLSearchParams(window.location.search);
const initialSymbol = (initialParams.get("symbol") || chainSymbolInput.value || "TSLA").trim().toUpperCase();
chainSymbolInput.value = initialSymbol;
loadChain(initialSymbol);
