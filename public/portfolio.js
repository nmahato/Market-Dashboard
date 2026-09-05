function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function changeClassFor(value) {
  return Number.isFinite(value) ? (value >= 0 ? "positive" : "negative") : "neutral";
}

const totalCostBasis = document.getElementById("totalCostBasis");
const totalMarketValue = document.getElementById("totalMarketValue");
const totalPnl = document.getElementById("totalPnl");
const totalPnlPercent = document.getElementById("totalPnlPercent");
const holdingForm = document.getElementById("holdingForm");
const holdingSymbol = document.getElementById("holdingSymbol");
const holdingSymbolSuggestions = document.getElementById("holdingSymbolSuggestions");
const holdingQuantity = document.getElementById("holdingQuantity");
const holdingAvgCost = document.getElementById("holdingAvgCost");
const holdingDate = document.getElementById("holdingDate");
const holdingStatus = document.getElementById("holdingStatus");
const holdingsBody = document.getElementById("holdingsBody");

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

function renderPortfolio(payload) {
  const holdings = Array.isArray(payload.holdings) ? payload.holdings : [];
  const totals = payload.totals || {};
  totalCostBasis.textContent = formatMoney(totals.costBasis);
  totalMarketValue.textContent = formatMoney(totals.marketValue);
  totalPnl.textContent = formatMoney(totals.unrealizedPnl);
  totalPnl.className = changeClassFor(totals.unrealizedPnl);
  totalPnlPercent.textContent = formatPercent(totals.unrealizedPnlPercent);
  totalPnlPercent.className = changeClassFor(totals.unrealizedPnlPercent);

  if (!holdings.length) {
    holdingsBody.innerHTML = '<tr><td colspan="9" class="loading">No holdings yet. Add one above.</td></tr>';
    return;
  }

  holdingsBody.innerHTML = holdings.map((holding) => `
    <tr>
      <td class="symbol"><a class="signal-link" href="/chart.html?symbol=${encodeURIComponent(holding.symbol)}">${escapeHtml(holding.symbol)}</a></td>
      <td>${holding.quantity}</td>
      <td>${formatMoney(holding.avgCost)}</td>
      <td>${formatMoney(holding.currentPrice)}</td>
      <td>${formatMoney(holding.costBasis)}</td>
      <td>${formatMoney(holding.marketValue)}</td>
      <td><span class="change ${changeClassFor(holding.unrealizedPnl)}">${formatMoney(holding.unrealizedPnl)}</span></td>
      <td><span class="change ${changeClassFor(holding.unrealizedPnlPercent)}">${formatPercent(holding.unrealizedPnlPercent)}</span></td>
      <td><button type="button" class="secondary-btn" data-remove-holding="${escapeHtml(holding.symbol)}">Remove</button></td>
    </tr>
  `).join("");
}

let isGuestUser = false;

async function loadPortfolio() {
  if (isGuestUser) return;
  try {
    const payload = await requestJson("/api/portfolio");
    renderPortfolio(payload);
  } catch (error) {
    holdingsBody.innerHTML = `<tr><td colspan="9" class="loading">${escapeHtml(error.message)}</td></tr>`;
  }
}

holdingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const symbol = holdingSymbol.value.trim().toUpperCase();
  if (!symbol) return;
  holdingStatus.textContent = `Adding ${symbol}...`;
  try {
    const payload = await requestJson("/api/portfolio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol,
        quantity: holdingQuantity.value,
        avg_cost: holdingAvgCost.value,
        purchase_date: holdingDate.value || null
      })
    });
    holdingForm.reset();
    holdingStatus.textContent = `Added ${symbol} to your portfolio.`;
    renderPortfolio(payload);
  } catch (error) {
    holdingStatus.textContent = error.message;
  }
});

holdingsBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-holding]");
  if (!button) return;
  const symbol = button.dataset.removeHolding;
  if (!window.confirm(`Remove ${symbol} from your portfolio?`)) return;
  try {
    const payload = await requestJson(`/api/portfolio/${encodeURIComponent(symbol)}`, { method: "DELETE" });
    holdingStatus.textContent = `Removed ${symbol}.`;
    renderPortfolio(payload);
  } catch (error) {
    holdingStatus.textContent = error.message;
  }
});

if (window.createStockSearch && holdingSymbolSuggestions) {
  window.createStockSearch({
    input: holdingSymbol,
    suggestions: holdingSymbolSuggestions
  });
}

document.addEventListener("account:ready", (event) => {
  const user = event.detail;
  if (user && user.role === "guest") {
    isGuestUser = true;
    holdingForm.querySelector("button[type=submit]").disabled = true;
    holdingStatus.textContent = "Guests can't track a portfolio. Create an account to use this page.";
    holdingsBody.innerHTML = '<tr><td colspan="9" class="loading">Sign up for an account to track a portfolio.</td></tr>';
    return;
  }
  loadPortfolio();
});

setInterval(loadPortfolio, 30000);
