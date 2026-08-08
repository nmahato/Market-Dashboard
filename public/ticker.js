(function () {
  const REFRESH_MS = 5000;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character]));
  }

  function formatPrice(value) {
    if (!Number.isFinite(value)) return "--";
    return value.toLocaleString("en-US", {
      maximumFractionDigits: value >= 1000 ? 0 : 2
    });
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return "--";
    return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  }

  const footer = document.createElement("footer");
  footer.id = "marketTicker";
  footer.className = "market-ticker";
  footer.innerHTML = `
    <div class="market-ticker-track">
      <div class="market-ticker-inner" data-group="a"><p class="loading">Loading market prices...</p></div>
      <div class="market-ticker-inner" data-group="b"><p class="loading">Loading market prices...</p></div>
    </div>
  `;
  document.body.appendChild(footer);
  const groupA = footer.querySelector('[data-group="a"]');
  const groupB = footer.querySelector('[data-group="b"]');

  function itemsMarkup(items) {
    return items.map((item) => {
      const changeClass = Number.isFinite(item.changePercent)
        ? (item.changePercent >= 0 ? "positive" : "negative")
        : "neutral";
      return `
        <span class="market-ticker-item">
          <strong>${escapeHtml(item.label)}</strong>
          <span class="market-ticker-price">${formatPrice(item.price)}</span>
          <span class="change ${changeClass}">${formatPercent(item.changePercent)}</span>
        </span>
      `;
    }).join("");
  }

  function setGroups(markup) {
    groupA.innerHTML = markup;
    groupB.innerHTML = markup;
  }

  function render(payload) {
    const items = Array.isArray(payload.items) ? payload.items : [];
    setGroups(items.length ? itemsMarkup(items) : '<p class="loading">Market prices unavailable.</p>');
  }

  async function load() {
    try {
      const response = await fetch("/api/market-ticker", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to load market prices");
      render(payload);
    } catch (error) {
      setGroups(`<p class="loading">${escapeHtml(error.message)}</p>`);
    }
  }

  load();
  setInterval(load, REFRESH_MS);
})();
