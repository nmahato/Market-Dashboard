const adminStatus = document.getElementById("adminStatus");
const addUserForm = document.getElementById("addUserForm");
const newUsername = document.getElementById("newUsername");
const newPassword = document.getElementById("newPassword");
const newRole = document.getElementById("newRole");
const usersList = document.getElementById("usersList");
const userCount = document.getElementById("userCount");
const whatsappGroupForm = document.getElementById("whatsappGroupForm");
const groupName = document.getElementById("groupName");
const webhookUrl = document.getElementById("webhookUrl");
const whatsappGroups = document.getElementById("whatsappGroups");
const groupCount = document.getElementById("groupCount");
const notificationState = document.getElementById("notificationState");
const notificationSummary = document.getElementById("notificationSummary");
const dailyStockState = document.getElementById("dailyStockState");
const dailyStocks = document.getElementById("dailyStocks");
const refreshDailyStocks = document.getElementById("refreshDailyStocks");
const saveWatchlist = document.getElementById("saveWatchlist");
const manualSymbolForm = document.getElementById("manualSymbolForm");
const manualSymbolInput = document.getElementById("manualSymbolInput");
const manualSymbolSuggestions = document.getElementById("manualSymbolSuggestions");
const tradingState = document.getElementById("tradingState");
const tradingSummary = document.getElementById("tradingSummary");
const bulkBrokerName = document.getElementById("bulkBrokerName");
const bulkTradeSymbols = document.getElementById("bulkTradeSymbols");
const bulkTradeStatus = document.getElementById("bulkTradeStatus");
const bulkBuy = document.getElementById("bulkBuy");
const bulkSell = document.getElementById("bulkSell");

let latestTradingStatus;
let latestWatchlistPayload;
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
  const response = await fetch(url, {
    ...options,
    cache: "no-store"
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

function renderUsers(users) {
  userCount.textContent = `${users.length} user${users.length === 1 ? "" : "s"}`;
  if (!users.length) {
    usersList.innerHTML = '<p class="loading">No users yet.</p>';
    return;
  }
  usersList.innerHTML = users.map((user) => `
    <article class="admin-list-item">
      <div>
        <strong>${escapeHtml(user.username)}</strong>
        <span>${escapeHtml(user.role)} - added ${escapeHtml(String(user.createdAt || "").slice(0, 10))}</span>
      </div>
      ${currentUser && user.username !== currentUser.username
        ? `<button type="button" class="secondary-btn" data-remove-user="${user.id}">Remove</button>`
        : ""}
    </article>
  `).join("");
}

async function loadUsers() {
  try {
    const payload = await requestJson("/api/admin/users");
    renderUsers(payload.users || []);
  } catch (error) {
    usersList.innerHTML = `<p class="loading">${escapeHtml(error.message)}</p>`;
  }
}

addUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await requestJson("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: newUsername.value.trim(),
        password: newPassword.value,
        role: newRole.value
      })
    });
    addUserForm.reset();
    renderUsers(payload.users || []);
  } catch (error) {
    adminStatus.textContent = error.message;
  }
});

usersList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-user]");
  if (!button) return;
  if (!window.confirm("Remove this user?")) return;
  try {
    const payload = await requestJson(`/api/admin/users/${button.dataset.removeUser}`, { method: "DELETE" });
    renderUsers(payload.users || []);
  } catch (error) {
    adminStatus.textContent = error.message;
  }
});

function renderGroups(groups) {
  const active = groups.filter((group) => group.enabled);
  groupCount.textContent = `${active.length} active`;
  if (!groups.length) {
    whatsappGroups.innerHTML = '<p class="loading">No WhatsApp groups added.</p>';
    return;
  }

  whatsappGroups.innerHTML = groups.map((group) => `
    <article class="admin-list-item ${group.enabled ? "" : "disabled"}">
      <div>
        <strong>${escapeHtml(group.name)}</strong>
        <span>${group.enabled ? "Active" : "Disabled"}</span>
        <code>${escapeHtml(group.webhookUrl)}</code>
      </div>
      ${group.enabled ? `<button type="button" class="secondary-btn" data-remove-group="${group.id}">Disable</button>` : ""}
    </article>
  `).join("");
}

function renderNotifications(status) {
  notificationState.textContent = status.enabled ? "Enabled" : "Disabled";
  const channels = status.channels.length ? status.channels.join(", ") : "None";
  notificationSummary.innerHTML = `
    <article class="admin-list-item">
      <div>
        <strong>Channels</strong>
        <span>${escapeHtml(channels)}</span>
      </div>
    </article>
    <article class="admin-list-item">
      <div>
        <strong>Cooldown</strong>
        <span>${Math.round(status.cooldownMs / 60000)} minutes</span>
      </div>
    </article>
    <article class="admin-list-item">
      <div>
        <strong>Recent alerts</strong>
        <span>${status.recent.length}</span>
      </div>
    </article>
  `;
}

function renderTrading(status) {
  tradingState.textContent = status.enabled ? "Enabled (Paper)" : "Disabled";
  const allowed = status.allowedSymbols.length ? status.allowedSymbols.join(", ") : "None";
  const recent = Array.isArray(status.recent) ? status.recent : [];
  tradingSummary.innerHTML = `
    <article class="admin-list-item">
      <div>
        <strong>Alpaca paper account</strong>
        <span>${status.configured ? "Credentials configured" : "Credentials not configured"}</span>
        <span>Allowed symbols: ${escapeHtml(allowed)}</span>
        <span>Buy size: $${Number(status.buyNotional).toFixed(2)} | Daily limit: ${status.maxDailyOrders}</span>
        <span>Sell rule: ${escapeHtml(status.sellBehavior)}</span>
      </div>
    </article>
    ${recent.length ? recent.map((trade) => `
      <article class="admin-list-item">
        <div>
          <strong>${escapeHtml(trade.side.toUpperCase())} ${escapeHtml(trade.symbol)} - ${escapeHtml(trade.status)}</strong>
          <span>${escapeHtml(trade.signal)} | ${escapeHtml(formatTime(trade.observedAt))}</span>
          ${trade.detail ? `<code>${escapeHtml(trade.detail)}</code>` : ""}
        </div>
      </article>
    `).join("") : '<p class="loading">No paper trades recorded.</p>'}
  `;
}

function renderBulkTrading(watchlist, trading) {
  latestWatchlistPayload = watchlist;
  latestTradingStatus = trading;
  bulkBrokerName.textContent = `${trading.provider} ${trading.environment === "paper" ? "Paper Trading" : trading.environment}`;
  const watched = Array.isArray(watchlist.symbols) ? watchlist.symbols : [];
  const allowed = new Set(Array.isArray(trading.allowedSymbols) ? trading.allowedSymbols : []);
  const eligible = watched.filter((symbol) => allowed.has(symbol));

  bulkBuy.disabled = !trading.enabled || !eligible.length;
  bulkSell.disabled = !trading.enabled || !eligible.length;
  if (!eligible.length) {
    bulkTradeSymbols.innerHTML = '<p class="loading">No watched stocks are also present in ALPACA_ALLOWED_SYMBOLS.</p>';
  } else {
    bulkTradeSymbols.innerHTML = eligible.map((symbol) => `
      <label class="admin-stock-chip bulk-symbol selected">
        <span class="admin-stock-choice">
          <input type="checkbox" name="bulkTradeSymbol" value="${escapeHtml(symbol)}" checked>
          <strong>${escapeHtml(symbol)}</strong>
        </span>
      </label>
    `).join("");
  }
  bulkTradeStatus.textContent = trading.enabled
    ? `Paper mode: each buy uses $${Number(trading.buyNotional).toFixed(2)}. Sells close existing long positions.`
    : "Bulk trading is disabled until Alpaca paper credentials, enable flag, and allowed symbols are configured.";
}

async function submitBulkTrade(side) {
  const symbols = Array.from(bulkTradeSymbols.querySelectorAll('input[name="bulkTradeSymbol"]:checked'))
    .map((input) => input.value);
  if (!symbols.length) {
    bulkTradeStatus.textContent = "Select at least one stock.";
    return;
  }
  const action = side === "buy"
    ? `paper-buy $${Number(latestTradingStatus.buyNotional).toFixed(2)} of each`
    : "close any existing paper long position in";
  if (!window.confirm(`Confirm: ${action} ${symbols.join(", ")} through Alpaca Paper Trading?`)) return;

  bulkBuy.disabled = true;
  bulkSell.disabled = true;
  bulkTradeStatus.textContent = `Submitting bulk paper ${side}...`;
  try {
    const payload = await requestJson("/api/admin/trading/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols, side })
    });
    const submitted = payload.results.filter((result) => result.status === "submitted").length;
    const skipped = payload.results.length - submitted;
    bulkTradeStatus.textContent = `${submitted} paper orders submitted; ${skipped} skipped or failed.`;
    latestTradingStatus = { ...latestTradingStatus, recent: payload.recent || [] };
    renderTrading(latestTradingStatus);
  } catch (error) {
    bulkTradeStatus.textContent = error.message;
  } finally {
    const finalMessage = bulkTradeStatus.textContent;
    renderBulkTrading(latestWatchlistPayload, latestTradingStatus);
    bulkTradeStatus.textContent = finalMessage;
  }
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
            <a href="/indicator.html?symbol=${encodeURIComponent(symbol)}">Signals</a>
            <a href="/news.html?q=${encodeURIComponent(symbol)}">News</a>
          </span>
        </label>
      `).join("")}
    </article>
  `;
}

async function loadAdmin() {
  try {
    const [groupPayload, statusPayload, topStocksPayload, tradingPayload] = await Promise.all([
      requestJson("/api/admin/whatsapp-groups"),
      requestJson("/api/notifications"),
      requestJson("/api/top-stocks"),
      requestJson("/api/trading")
    ]);
    renderGroups(groupPayload.groups || []);
    renderNotifications(statusPayload);
    renderDailyStocks(topStocksPayload);
    renderTrading(tradingPayload);
    renderBulkTrading(topStocksPayload, tradingPayload);
    adminStatus.textContent = `Signed in as ${currentUser.username} (admin).`;
    loadUsers();
  } catch (error) {
    adminStatus.textContent = error.message;
    whatsappGroups.innerHTML = '<p class="loading">Unable to load WhatsApp groups.</p>';
  }
}

document.addEventListener("account:ready", (event) => {
  currentUser = event.detail;
  if (currentUser && currentUser.role === "admin") {
    loadAdmin();
  } else {
    adminStatus.textContent = "Sign in as an admin (top right) to manage this page.";
    usersList.innerHTML = '<p class="loading">Sign in as an admin to manage users.</p>';
  }
});

whatsappGroupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminStatus.textContent = "Adding WhatsApp group...";
  try {
    const payload = await requestJson("/api/admin/whatsapp-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: groupName.value,
        webhookUrl: webhookUrl.value
      })
    });
    groupName.value = "";
    webhookUrl.value = "";
    renderGroups(payload.groups || []);
    await loadAdmin();
    adminStatus.textContent = "WhatsApp group added.";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
});

whatsappGroups.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-group]");
  if (!button) return;
  adminStatus.textContent = "Disabling WhatsApp group...";
  try {
    const payload = await requestJson(`/api/admin/whatsapp-groups/${button.dataset.removeGroup}`, {
      method: "DELETE"
    });
    renderGroups(payload.groups || []);
    await loadAdmin();
    adminStatus.textContent = "WhatsApp group disabled.";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
});

refreshDailyStocks.addEventListener("click", async () => {
  adminStatus.textContent = "Refreshing daily stocks...";
  refreshDailyStocks.disabled = true;
  try {
    const payload = await requestJson("/api/top-stocks?refresh=1");
    renderDailyStocks(payload);
    if (latestTradingStatus) renderBulkTrading(payload, latestTradingStatus);
    adminStatus.textContent = "Daily stocks refreshed.";
  } catch (error) {
    adminStatus.textContent = error.message;
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
  adminStatus.textContent = "Saving watchlist...";
  saveWatchlist.disabled = true;
  try {
    const payload = await requestJson("/api/admin/watchlist", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols })
    });
    renderDailyStocks(payload);
    if (latestTradingStatus) renderBulkTrading(payload, latestTradingStatus);
    adminStatus.textContent = `${payload.symbols.length} stocks selected for RSI Watch.`;
  } catch (error) {
    adminStatus.textContent = error.message;
  } finally {
    saveWatchlist.disabled = false;
  }
});

manualSymbolForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  let symbols = manualSymbolInput.value.trim();
  if (!symbols) return;
  adminStatus.textContent = "Adding manual ticker...";
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
    if (latestTradingStatus) renderBulkTrading(payload, latestTradingStatus);
    adminStatus.textContent = "Manual ticker added and selected for watching.";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
});

if (window.createStockSearch && manualSymbolSuggestions) {
  manualSymbolSearch = window.createStockSearch({
    input: manualSymbolInput,
    suggestions: manualSymbolSuggestions
  });
}

bulkTradeSymbols.addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[name="bulkTradeSymbol"]');
  if (checkbox) checkbox.closest(".admin-stock-chip").classList.toggle("selected", checkbox.checked);
});

bulkBuy.addEventListener("click", () => submitBulkTrade("buy"));
bulkSell.addEventListener("click", () => submitBulkTrade("sell"));
