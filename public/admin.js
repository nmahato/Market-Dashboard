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

async function loadAdmin() {
  try {
    const [groupPayload, statusPayload] = await Promise.all([
      requestJson("/api/admin/whatsapp-groups"),
      requestJson("/api/notifications")
    ]);
    renderGroups(groupPayload.groups || []);
    renderNotifications(statusPayload);
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

loadAdmin();
