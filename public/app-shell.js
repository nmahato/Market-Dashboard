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

  const ICONS = {
    watch: '<svg viewBox="0 0 24 24"><path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>',
    chart: '<svg viewBox="0 0 24 24"><path d="M3 17 9 9l4 4 8-10"/><path d="M14 3h7v7"/></svg>',
    options: '<svg viewBox="0 0 24 24"><path d="M4 19V5m0 14 5-6 4 3 7-9"/></svg>',
    news: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/></svg>',
    admin: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z"/></svg>'
  };

  const NAV_ITEMS = [
    { href: "/index.html", label: "Dashboard", icon: "watch" },
    { href: "/search.html", label: "Search", icon: "search", group: ["/search.html", "/"] },
    { href: "/chart.html", label: "Chart", icon: "chart" },
    { href: "/options.html", label: "Options", icon: "options", group: ["/options.html", "/strangle.html", "/strategies.html"] },
    { href: "/news.html", label: "News", icon: "news" },
    { href: "/admin.html", label: "Admin", icon: "admin" }
  ];

  function isActive(item) {
    const path = location.pathname;
    const candidates = item.group || [item.href];
    return candidates.includes(path);
  }

  function navLinksMarkup(className) {
    return NAV_ITEMS.map((item) => {
      const active = isActive(item);
      return `<a href="${item.href}" class="${className}"${active ? ' aria-current="page"' : ""}>${ICONS[item.icon]}<span>${escapeHtml(item.label)}</span></a>`;
    }).join("");
  }

  function brandMarkup() {
    return `
      <a href="/search.html" class="sidebar-brand">
        <span class="sidebar-brand-mark"></span>
        <span class="sidebar-brand-text"><strong>Market Dashboard</strong><span>Live RSI &amp; Options</span></span>
      </a>
    `;
  }

  function mountSidebar() {
    const sidebar = document.getElementById("appSidebar");
    if (!sidebar) return;
    sidebar.innerHTML = `
      ${brandMarkup()}
      <button type="button" class="sidebar-search-btn" id="commandPaletteTrigger">
        <span>Jump to symbol or page&hellip;</span>
        <span class="hint"><kbd>Ctrl</kbd><kbd>K</kbd></span>
      </button>
      <nav class="sidebar-nav" aria-label="Dashboard pages">${navLinksMarkup("")}</nav>
      <div class="sidebar-footer">
        <div class="topbar-actions"></div>
      </div>
    `;
  }

  function mountMobileChrome() {
    const main = document.querySelector(".app-main");
    if (!main) return;

    const topbar = document.createElement("div");
    topbar.className = "mobile-topbar";
    topbar.innerHTML = `
      <button type="button" class="mobile-menu-btn" id="mobileMenuBtn" aria-label="Open navigation" aria-expanded="false">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
      </button>
      ${brandMarkup()}
    `;
    main.insertBefore(topbar, main.firstChild);

    const backdrop = document.createElement("div");
    backdrop.className = "nav-backdrop";
    backdrop.id = "navBackdrop";
    document.body.appendChild(backdrop);

    const tabbar = document.createElement("nav");
    tabbar.className = "mobile-tabbar";
    tabbar.setAttribute("aria-label", "Dashboard pages");
    tabbar.innerHTML = navLinksMarkup("");
    document.body.appendChild(tabbar);

    const sidebar = document.getElementById("appSidebar");
    const menuBtn = document.getElementById("mobileMenuBtn");

    function closeDrawer() {
      if (sidebar) sidebar.classList.remove("open");
      backdrop.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
    }

    function openDrawer() {
      if (sidebar) sidebar.classList.add("open");
      backdrop.classList.add("open");
      menuBtn.setAttribute("aria-expanded", "true");
    }

    menuBtn.addEventListener("click", () => {
      if (sidebar && sidebar.classList.contains("open")) closeDrawer();
      else openDrawer();
    });
    backdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDrawer();
    });
  }

  function mountCommandPalette() {
    const backdrop = document.createElement("div");
    backdrop.className = "command-palette-backdrop";
    backdrop.id = "commandPaletteBackdrop";
    backdrop.innerHTML = `
      <div class="command-palette" role="dialog" aria-label="Quick navigation">
        <input type="text" id="commandPaletteInput" placeholder="Jump to a page or search a symbol&hellip;" autocomplete="off">
        <div class="command-palette-results" id="commandPaletteResults"></div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const input = document.getElementById("commandPaletteInput");
    const results = document.getElementById("commandPaletteResults");
    const trigger = document.getElementById("commandPaletteTrigger");
    let items = [];
    let activeIndex = -1;
    let requestId = 0;

    function pageMatches(query) {
      const lower = query.trim().toLowerCase();
      return NAV_ITEMS
        .filter((item) => !lower || item.label.toLowerCase().includes(lower))
        .map((item) => ({ type: "page", label: item.label, href: item.href, hint: "Page" }));
    }

    function render() {
      if (!items.length) {
        results.innerHTML = '<p class="command-palette-empty">No matches.</p>';
        return;
      }
      results.innerHTML = items.map((item, index) => `
        <button type="button" class="command-palette-item${index === activeIndex ? " active" : ""}" data-index="${index}">
          <span>${escapeHtml(item.label)}</span>
          <span class="hint">${escapeHtml(item.hint)}</span>
        </button>
      `).join("");
    }

    function open() {
      backdrop.classList.add("open");
      input.value = "";
      activeIndex = -1;
      items = pageMatches("");
      render();
      setTimeout(() => input.focus(), 0);
    }

    function close() {
      backdrop.classList.remove("open");
    }

    function choose(index) {
      const item = items[index];
      if (!item) return;
      if (item.type === "page") {
        location.href = item.href;
      } else {
        location.href = `/chart.html?symbol=${encodeURIComponent(item.symbol)}`;
      }
    }

    async function search(query) {
      const currentRequest = ++requestId;
      const pages = pageMatches(query);
      if (query.trim().length < 2) {
        items = pages;
        activeIndex = -1;
        render();
        return;
      }
      try {
        const response = await fetch(`/api/search-symbols?q=${encodeURIComponent(query.trim())}`, { cache: "no-store" });
        const payload = await response.json();
        if (currentRequest !== requestId) return;
        const symbolMatches = (Array.isArray(payload.results) ? payload.results : []).slice(0, 8).map((result) => ({
          type: "symbol",
          label: `${result.symbol} — ${result.name || ""}`.trim(),
          symbol: result.symbol,
          hint: result.exchange || "Symbol"
        }));
        items = [...pages, ...symbolMatches];
        activeIndex = -1;
        render();
      } catch (error) {
        if (currentRequest !== requestId) return;
        items = pages;
        render();
      }
    }

    if (trigger) trigger.addEventListener("click", open);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener("keydown", (event) => {
      const isShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (isShortcut) {
        event.preventDefault();
        if (backdrop.classList.contains("open")) close();
        else open();
      } else if (event.key === "Escape" && backdrop.classList.contains("open")) {
        close();
      }
    });
    input.addEventListener("input", () => search(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        render();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        render();
      } else if (event.key === "Enter") {
        event.preventDefault();
        choose(activeIndex >= 0 ? activeIndex : 0);
      }
    });
    results.addEventListener("click", (event) => {
      const button = event.target.closest("[data-index]");
      if (!button) return;
      choose(Number(button.dataset.index));
    });
  }

  mountSidebar();
  mountMobileChrome();
  mountCommandPalette();
}());
