const stocksStatus = document.getElementById("stocksStatus");
const dailyStockState = document.getElementById("dailyStockState");
const dailyStocks = document.getElementById("dailyStocks");
const refreshDailyStocks = document.getElementById("refreshDailyStocks");
const saveWatchlist = document.getElementById("saveWatchlist");
const manualSymbolForm = document.getElementById("manualSymbolForm");
const manualSymbolInput = document.getElementById("manualSymbolInput");
const manualSymbolSuggestions = document.getElementById("manualSymbolSuggestions");

let manualSymbolSearch;
let currentUser = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function renderDailyStocks(payload) {
  const topStocks = payload.topStocks || {};
  const topSymbols = Array.isArray(topStocks.symbols) ? topStocks.symbols : [];
  const manualSymbols = Array.isArray(payload.manualSymbols) ? payload.manualSymbols : [];
  const manualSet = new Set(manualSymbols);
  const symbols = Array.from(new Set([...topSymbols, ...manualSymbols]));
  dailyStockState.textContent = `${topSymbols.length} daily + ${manualSymbols.length} manual`;

  if (!symbols.length) {
    dailyStocks.innerHTML = '<p class="loading">No daily stocks loaded.</p>';
    return;
  }

  const selectedSymbols = new Set(Array.isArray(payload.selectedSymbols) ? payload.selectedSymbols : symbols);
  const meta = [
    `Source: ${topStocks.source || "Unknown"}`,
    `Date: ${topStocks.date || "--"}`,
    `Updated: ${formatTime(topStocks.updatedAt)}`,
    manualSymbols.length ? `Manual: ${manualSymbols.join(", ")}` : ""
  ].filter(Boolean).join(" | ");

  dailyStocks.innerHTML = `
    <article class="admin-list-item">
      <div>
        <strong>Daily Top List</strong>
        <span>${escapeHtml(meta)}</span>
        ${topStocks.error ? `<code>${escapeHtml(topStocks.error)}</code>` : ""}
      </div>
    </article>
    <article class="admin-stock-grid">
      ${symbols.map((symbol) => `
        <label class="admin-stock-chip ${selectedSymbols.has(symbol) ? "selected" : ""}">
          <span class="admin-stock-choice">
            <input type="checkbox" name="watchSymbol" value="${escapeHtml(symbol)}" ${selectedSymbols.has(symbol) ? "checked" : ""}>
            <strong>${escapeHtml(symbol)}</strong>
            ${manualSet.has(symbol) ? '<small class="manual-stock-label">Manual</small>' : ""}
          </span>
          <span>
            <a href="/chart.html?symbol=${encodeURIComponent(symbol)}">Chart</a>
            <a href="/news.html?q=${encodeURIComponent(symbol)}">News</a>
          </span>
        </label>
      `).join("")}
    </article>
  `;
}

async function loadStocks() {
  try {
    const payload = await requestJson("/api/top-stocks");
    renderDailyStocks(payload);
    stocksStatus.textContent = `Signed in as ${currentUser.username} (admin).`;
  } catch (error) {
    stocksStatus.textContent = error.message;
  }
}

refreshDailyStocks.addEventListener("click", async () => {
  stocksStatus.textContent = "Refreshing daily stocks...";
  refreshDailyStocks.disabled = true;
  try {
    const payload = await requestJson("/api/top-stocks?refresh=1");
    renderDailyStocks(payload);
    stocksStatus.textContent = "Daily stocks refreshed.";
  } catch (error) {
    stocksStatus.textContent = error.message;
  } finally {
    refreshDailyStocks.disabled = false;
  }
});

dailyStocks.addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[name="watchSymbol"]');
  if (checkbox) checkbox.closest(".admin-stock-chip").classList.toggle("selected", checkbox.checked);
});

saveWatchlist.addEventListener("click", async () => {
  const symbols = Array.from(dailyStocks.querySelectorAll('input[name="watchSymbol"]:checked'))
    .map((input) => input.value);
  stocksStatus.textContent = "Saving watchlist...";
  saveWatchlist.disabled = true;
  try {
    const payload = await requestJson("/api/admin/watchlist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols })
    });
    renderDailyStocks(payload);
    stocksStatus.textContent = `${payload.symbols.length} stocks selected for the shared pool.`;
  } catch (error) {
    stocksStatus.textContent = error.message;
  } finally {
    saveWatchlist.disabled = false;
  }
});

manualSymbolForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  let symbols = manualSymbolInput.value.trim();
  if (!symbols) return;
  stocksStatus.textContent = "Adding manual ticker...";
  try {
    if (!symbols.includes(",") && window.resolveStockSymbol) {
      symbols = await window.resolveStockSymbol(symbols);
    }
    const payload = await requestJson("/api/admin/watchlist/symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols })
    });
    manualSymbolInput.value = "";
    if (manualSymbolSearch) manualSymbolSearch.hide();
    renderDailyStocks(payload);
    stocksStatus.textContent = "Manual ticker added and selected for watching.";
  } catch (error) {
    stocksStatus.textContent = error.message;
  }
});

if (window.createStockSearch && manualSymbolSuggestions) {
  manualSymbolSearch = window.createStockSearch({
    input: manualSymbolInput,
    suggestions: manualSymbolSuggestions
  });
}

document.addEventListener("account:ready", (event) => {
  currentUser = event.detail;
  if (currentUser && currentUser.role === "admin") {
    loadStocks();
  } else {
    stocksStatus.textContent = "Sign in as an admin to manage stocks.";
    dailyStocks.innerHTML = '<p class="loading">Sign in as an admin to manage stocks.</p>';
  }
});
