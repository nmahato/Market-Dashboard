(function () {
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character]));
  }

  const host = document.querySelector(".topbar-actions") || document.querySelector(".topbar");
  const widget = host ? document.createElement("div") : null;
  if (widget) {
    widget.className = "account-widget";
    widget.id = "accountWidget";
    host.appendChild(widget);
  }

  function renderSignedOut() {
    if (!widget) return;
    widget.innerHTML = `
      <button id="accountSignInBtn" type="button" class="secondary-btn">Sign in</button>
      <form id="accountLoginForm" class="account-popover" hidden>
        <label for="accountUsername">Username</label>
        <input id="accountUsername" name="username" type="text" autocomplete="username" required>
        <label for="accountPassword">Password</label>
        <input id="accountPassword" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Sign in</button>
        <p id="accountLoginError" class="account-error"></p>
      </form>
    `;
    const button = widget.querySelector("#accountSignInBtn");
    const form = widget.querySelector("#accountLoginForm");
    const error = widget.querySelector("#accountLoginError");

    button.addEventListener("click", () => {
      form.hidden = !form.hidden;
      if (!form.hidden) widget.querySelector("#accountUsername").focus();
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      const username = widget.querySelector("#accountUsername").value.trim();
      const password = widget.querySelector("#accountPassword").value;
      try {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Sign in failed");
        window.location.reload();
      } catch (err) {
        error.textContent = err.message;
      }
    });
  }

  function renderSignedIn(user) {
    if (!widget) return;
    widget.innerHTML = `
      <span class="account-name">${escapeHtml(user.username)}</span>
      <span class="account-role account-role-${escapeHtml(user.role)}">${escapeHtml(user.role)}</span>
      <button id="accountSignOutBtn" type="button" class="secondary-btn">Sign out</button>
    `;
    widget.querySelector("#accountSignOutBtn").addEventListener("click", async () => {
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } finally {
        window.location.reload();
      }
    });
  }

  async function init() {
    let user = null;
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      const payload = await response.json();
      user = payload && payload.username ? payload : null;
    } catch (error) {
      user = null;
    }
    window.marketDashboardUser = user;
    if (user) {
      renderSignedIn(user);
    } else {
      renderSignedOut();
    }
    document.dispatchEvent(new CustomEvent("account:ready", { detail: user }));
  }

  init();
})();
