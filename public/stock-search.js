(function () {
  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[character];
    });
  }

  function createStockSearch(options) {
    var input = options.input;
    var suggestions = options.suggestions;
    var onSelect = options.onSelect;
    var requestId = 0;
    var activeIndex = -1;
    var items = [];
    var timer = null;

    function hideSuggestions() {
      suggestions.hidden = true;
      suggestions.innerHTML = "";
      activeIndex = -1;
      items = [];
    }

    function selectItem(item) {
      input.value = item.symbol;
      hideSuggestions();
      if (typeof onSelect === "function") onSelect(item);
    }

    function renderResults(results) {
      items = results;
      activeIndex = -1;
      if (!items.length) {
        suggestions.hidden = false;
        suggestions.innerHTML = '<div class="stock-suggestion empty">No matches</div>';
        return;
      }

      suggestions.hidden = false;
      suggestions.innerHTML = items.map(function (item, index) {
        return [
          '<button type="button" class="stock-suggestion" data-index="', index, '">',
          '<strong>', escapeHtml(item.symbol), '</strong>',
          '<span>', escapeHtml(item.name), '</span>',
          '<em>', escapeHtml(item.exchange || item.type), '</em>',
          '</button>'
        ].join("");
      }).join("");
    }

    async function search() {
      var query = input.value.trim();
      var currentRequest = ++requestId;
      if (query.length < 2 || query.includes(",")) {
        hideSuggestions();
        return;
      }

      suggestions.hidden = false;
      suggestions.innerHTML = '<div class="stock-suggestion empty">Searching...</div>';
      try {
        var response = await fetch("/api/search-symbols?q=" + encodeURIComponent(query), {
          cache: "no-store"
        });
        var payload = await response.json();
        if (currentRequest !== requestId) return;
        if (!response.ok) throw new Error(payload.error || "Search failed");
        renderResults(Array.isArray(payload.results) ? payload.results : []);
      } catch (error) {
        if (currentRequest !== requestId) return;
        suggestions.hidden = false;
        suggestions.innerHTML = '<div class="stock-suggestion empty">' + escapeHtml(error.message) + '</div>';
      }
    }

    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(search, 220);
    });

    input.addEventListener("keydown", function (event) {
      if (suggestions.hidden || !items.length) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
      } else if (event.key === "Enter" && activeIndex >= 0) {
        event.preventDefault();
        selectItem(items[activeIndex]);
      } else if (event.key === "Escape") {
        hideSuggestions();
      } else {
        return;
      }

      Array.from(suggestions.querySelectorAll(".stock-suggestion")).forEach(function (button, index) {
        button.classList.toggle("active", index === activeIndex);
      });
    });

    suggestions.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-index]");
      if (!button) return;
      selectItem(items[Number(button.dataset.index)]);
    });

    document.addEventListener("click", function (event) {
      if (!input.contains(event.target) && !suggestions.contains(event.target)) {
        hideSuggestions();
      }
    });

    return {
      hide: hideSuggestions
    };
  }

  async function resolveStockSymbol(query) {
    var value = String(query || "").trim();
    if (!value || value.includes(",")) return value;

    var response = await fetch("/api/search-symbols?q=" + encodeURIComponent(value), {
      cache: "no-store"
    });
    var payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Search failed");

    var results = Array.isArray(payload.results) ? payload.results : [];
    if (!results.length) return value.toUpperCase();

    var upperValue = value.toUpperCase();
    var exactMatch = results.find(function (item) {
      return item.symbol === upperValue;
    });
    return (exactMatch || results[0]).symbol;
  }

  window.createStockSearch = createStockSearch;
  window.resolveStockSymbol = resolveStockSymbol;
}());
