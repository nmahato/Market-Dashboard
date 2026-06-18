const adminTokenForm = document.getElementById("adminTokenForm");
const adminToken = document.getElementById("adminToken");
const adminStatus = document.getElementById("adminStatus");
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

let token = sessionStorage.getItem("marketDashboardAdminToken") || "";
adminToken.value = token;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function adminHeaders() {
  return token ? { "x-admin-token": token } : {};
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...adminHeaders(),
      ...(options.headers || {})
    },
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

function renderDailyStocks(payload) {
  const topStocks = payload.topStocks || {};
  const symbols = Array.isArray(topStocks.symbols) ? topStocks.symbols : [];
  dailyStockState.textContent = `${symbols.length} symbols`;

  if (!symbols.length) {
    dailyStocks.innerHTML = '<p class="loading">No daily stocks loaded.</p>';
    return;
  }

  const manualSymbols = Array.isArray(payload.manualSymbols) ? payload.manualSymbols : [];
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
        <div class="admin-stock-chip">
          <strong>${escapeHtml(symbol)}</strong>
          <span>
            <a href="/indicator.html?symbol=${encodeURIComponent(symbol)}">Signals</a>
            <a href="/news.html?q=${encodeURIComponent(symbol)}">News</a>
          </span>
        </div>
      `).join("")}
    </article>
  `;
}

async function loadAdmin() {
  try {
    const [groupPayload, statusPayload, topStocksPayload] = await Promise.all([
      requestJson("/api/admin/whatsapp-groups"),
      requestJson("/api/notifications"),
      requestJson("/api/top-stocks")
    ]);
    renderGroups(groupPayload.groups || []);
    renderNotifications(statusPayload);
    renderDailyStocks(topStocksPayload);
    adminStatus.textContent = groupPayload.protected
      ? "Admin token protection is enabled."
      : "Admin token protection is not enabled on the server.";
  } catch (error) {
    adminStatus.textContent = error.message;
    whatsappGroups.innerHTML = '<p class="loading">Unable to load WhatsApp groups.</p>';
  }
}

adminTokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  token = adminToken.value.trim();
  if (token) {
    sessionStorage.setItem("marketDashboardAdminToken", token);
  } else {
    sessionStorage.removeItem("marketDashboardAdminToken");
  }
  loadAdmin();
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
    adminStatus.textContent = "Daily stocks refreshed.";
  } catch (error) {
    adminStatus.textContent = error.message;
  } finally {
    refreshDailyStocks.disabled = false;
  }
});

loadAdmin();
