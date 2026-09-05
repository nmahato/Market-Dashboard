const adminStatus = document.getElementById("adminStatus");
const whatsappGroupForm = document.getElementById("whatsappGroupForm");
const groupName = document.getElementById("groupName");
const webhookUrl = document.getElementById("webhookUrl");
const whatsappGroups = document.getElementById("whatsappGroups");
const groupCount = document.getElementById("groupCount");
const notificationState = document.getElementById("notificationState");
const notificationSummary = document.getElementById("notificationSummary");
const tradingState = document.getElementById("tradingState");
const tradingSummary = document.getElementById("tradingSummary");
const bulkBrokerName = document.getElementById("bulkBrokerName");
const bulkTradeSymbols = document.getElementById("bulkTradeSymbols");
const bulkTradeStatus = document.getElementById("bulkTradeStatus");
const bulkBuy = document.getElementById("bulkBuy");
const bulkSell = document.getElementById("bulkSell");

let latestTradingStatus;
let latestWatchlistPayload;
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

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
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
    renderTrading(tradingPayload);
    renderBulkTrading(topStocksPayload, tradingPayload);
    adminStatus.textContent = `Signed in as ${currentUser.username} (admin).`;
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
    adminStatus.textContent = "Sign in as an admin to manage this page.";
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
    adminStatus.textContent = "WhatsApp group disabled.";
  } catch (error) {
    adminStatus.textContent = error.message;
  }
});

bulkTradeSymbols.addEventListener("change", (event) => {
  const checkbox = event.target.closest('input[name="bulkTradeSymbol"]');
  if (checkbox) checkbox.closest(".admin-stock-chip").classList.toggle("selected", checkbox.checked);
});

bulkBuy.addEventListener("click", () => submitBulkTrade("buy"));
bulkSell.addEventListener("click", () => submitBulkTrade("sell"));
