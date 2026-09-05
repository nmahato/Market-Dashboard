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

function formatVolume(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatEps(value) {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function formatSurprise(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function timeAgo(value) {
  if (!value) return "Unknown time";
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "Unknown time";
  const minutes = Math.max(0, Math.floor(elapsed / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function symbolLink(symbol) {
  return `<a class="signal-link" href="/chart.html?symbol=${encodeURIComponent(symbol)}">${escapeHtml(symbol)}</a>`;
}

function changeSpan(value) {
  const changeClass = Number.isFinite(value) ? (value >= 0 ? "positive" : "negative") : "neutral";
  return `<span class="change ${changeClass}">${formatPercent(value)}</span>`;
}

function createSortableTable({ tableEl, tbodyEl, countEl, columns, emptyText, noun, renderRow, defaultSort }) {
  let rows = [];
  let sortKey = defaultSort.key;
  let direction = defaultSort.direction;
  const buttons = Array.from(tableEl.querySelectorAll(".sort-btn"));

  function sortValue(row, key) {
    const value = row[key];
    if (typeof value === "string") return value.toUpperCase();
    return Number.isFinite(value) ? value : null;
  }

  function compare(a, b) {
    const first = sortValue(a, sortKey);
    const second = sortValue(b, sortKey);
    const emptyFirst = first === null || first === undefined || first === "";
    const emptySecond = second === null || second === undefined || second === "";
    if (emptyFirst && emptySecond) return 0;
    if (emptyFirst) return 1;
    if (emptySecond) return -1;
    const sign = direction === "asc" ? 1 : -1;
    if (typeof first === "string" || typeof second === "string") {
      return String(first).localeCompare(String(second)) * sign;
    }
    return (first - second) * sign;
  }

  function updateButtons() {
    buttons.forEach((button) => {
      const isActive = button.dataset.sortKey === sortKey;
      const icon = button.querySelector("span");
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-sort", isActive ? (direction === "asc" ? "ascending" : "descending") : "none");
      if (icon) icon.textContent = isActive ? (direction === "asc" ? "▲" : "▼") : "";
    });
  }

  function render() {
    if (!rows.length) {
      tbodyEl.innerHTML = `<tr><td colspan="${columns}" class="loading">${emptyText}</td></tr>`;
      if (countEl) countEl.textContent = `0 ${noun}`;
      updateButtons();
      return;
    }
    if (countEl) countEl.textContent = `${rows.length} ${noun}`;
    tbodyEl.innerHTML = [...rows].sort(compare).map(renderRow).join("");
    updateButtons();
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.sortKey;
      if (sortKey === key) {
        direction = direction === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        direction = key === "symbol" || key === "company" || key === "timing" ? "asc" : "desc";
      }
      render();
    });
  });

  updateButtons();

  return {
    setRows(newRows) {
      rows = Array.isArray(newRows) ? newRows : [];
      render();
    }
  };
}

const overviewForm = document.getElementById("overviewForm");
const overviewMinPrice = document.getElementById("overviewMinPrice");
const refreshOverview = document.getElementById("refreshOverview");
const overviewStatus = document.getElementById("overviewStatus");
const overviewDot = document.getElementById("overviewDot");

const earningsTodayBody = document.getElementById("earningsTodayBody");
const earningsTodayHelper = document.getElementById("earningsTodayHelper");
const newsTodayList = document.getElementById("newsTodayList");
const newsTodayHelper = document.getElementById("newsTodayHelper");

let isLoading = false;

function stockRow(row) {
  return `
    <tr>
      <td class="symbol">${symbolLink(row.symbol)}</td>
      <td>${formatMoney(row.price)}</td>
      <td>${changeSpan(row.todayChangePercent)}</td>
      <td>${formatVolume(row.volume)}</td>
    </tr>
  `;
}

const gainersTable = createSortableTable({
  tableEl: document.getElementById("gainersBody").closest("table"),
  tbodyEl: document.getElementById("gainersBody"),
  countEl: document.getElementById("gainersCount"),
  columns: 4,
  emptyText: "No matches right now.",
  noun: "stocks",
  renderRow: stockRow,
  defaultSort: { key: "todayChangePercent", direction: "desc" }
});

const losersTable = createSortableTable({
  tableEl: document.getElementById("losersBody").closest("table"),
  tbodyEl: document.getElementById("losersBody"),
  countEl: document.getElementById("losersCount"),
  columns: 4,
  emptyText: "No matches right now.",
  noun: "stocks",
  renderRow: stockRow,
  defaultSort: { key: "todayChangePercent", direction: "asc" }
});

const newHighsTable = createSortableTable({
  tableEl: document.getElementById("newHighsBody").closest("table"),
  tbodyEl: document.getElementById("newHighsBody"),
  countEl: document.getElementById("newHighsCount"),
  columns: 4,
  emptyText: "No matches right now.",
  noun: "stocks",
  renderRow: (row) => `
    <tr>
      <td class="symbol">${symbolLink(row.symbol)}</td>
      <td>${formatMoney(row.price)}</td>
      <td>${formatMoney(row.fiftyTwoWeekHigh)}</td>
      <td>${changeSpan(row.todayChangePercent)}</td>
    </tr>
  `,
  defaultSort: { key: "price", direction: "desc" }
});

const newLowsTable = createSortableTable({
  tableEl: document.getElementById("newLowsBody").closest("table"),
  tbodyEl: document.getElementById("newLowsBody"),
  countEl: document.getElementById("newLowsCount"),
  columns: 4,
  emptyText: "No matches right now.",
  noun: "stocks",
  renderRow: (row) => `
    <tr>
      <td class="symbol">${symbolLink(row.symbol)}</td>
      <td>${formatMoney(row.price)}</td>
      <td>${formatMoney(row.fiftyTwoWeekLow)}</td>
      <td>${changeSpan(row.todayChangePercent)}</td>
    </tr>
  `,
  defaultSort: { key: "price", direction: "asc" }
});

const bulkDealTable = createSortableTable({
  tableEl: document.getElementById("bulkDealBody").closest("table"),
  tbodyEl: document.getElementById("bulkDealBody"),
  countEl: document.getElementById("bulkDealCount"),
  columns: 4,
  emptyText: "No matches right now.",
  noun: "stocks",
  renderRow: (row) => `
    <tr>
      <td class="symbol">${symbolLink(row.symbol)}</td>
      <td>${formatMoney(row.price)}</td>
      <td>${Number.isFinite(row.relativeVolume) ? `${row.relativeVolume.toFixed(2)}x` : "--"}</td>
      <td>${formatVolume(row.volume)}</td>
    </tr>
  `,
  defaultSort: { key: "relativeVolume", direction: "desc" }
});

const earningsTable = createSortableTable({
  tableEl: earningsTodayBody.closest("table"),
  tbodyEl: earningsTodayBody,
  countEl: null,
  columns: 6,
  emptyText: "No earnings scheduled today.",
  noun: "companies",
  renderRow: (event) => `
    <tr>
      <td class="symbol">${symbolLink(event.symbol)}</td>
      <td>${escapeHtml(event.company || "--")}</td>
      <td><span class="badge WATCH">${event.timing === "BMO" ? "Before Open" : event.timing === "AMC" ? "After Close" : "--"}</span></td>
      <td>${formatEps(event.epsEstimate)}</td>
      <td>${formatEps(event.epsActual)}</td>
      <td>${formatSurprise(event.epsSurprisePercent)}</td>
    </tr>
  `,
  defaultSort: { key: "symbol", direction: "asc" }
});

function setOverviewStatus(text, state) {
  overviewStatus.textContent = text;
  overviewDot.classList.toggle("live", state === "live");
  overviewDot.classList.toggle("error", state === "error");
}

async function fetchScreener(preset, minPrice, limit = 50) {
  const params = new URLSearchParams({ preset, minPrice, limit, sort: "change", direction: "desc" });
  const response = await fetch(`/api/screener?${params.toString()}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return Array.isArray(payload.data) ? payload.data : [];
}

async function loadStockSections(minPrice) {
  const [mostActive, gainers, losers] = await Promise.all([
    fetchScreener("most-active", minPrice, 50),
    fetchScreener("top-gainers", minPrice, 50),
    fetchScreener("top-losers", minPrice, 50)
  ]);

  gainersTable.setRows(gainers.slice(0, 20));
  losersTable.setRows(losers.slice(0, 20));

  const merged = new Map();
  [...mostActive, ...gainers, ...losers].forEach((row) => {
    if (row && row.symbol && row.state !== "ERROR") merged.set(row.symbol, row);
  });
  const mergedRows = [...merged.values()];

  const newHighs = mergedRows
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.fiftyTwoWeekHigh) && row.fiftyTwoWeekHigh > 0 && row.price >= row.fiftyTwoWeekHigh * 0.999)
    .sort((a, b) => (b.price / b.fiftyTwoWeekHigh) - (a.price / a.fiftyTwoWeekHigh))
    .slice(0, 20);
  newHighsTable.setRows(newHighs);

  const newLows = mergedRows
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.fiftyTwoWeekLow) && row.fiftyTwoWeekLow > 0 && row.price <= row.fiftyTwoWeekLow * 1.001)
    .sort((a, b) => (a.price / a.fiftyTwoWeekLow) - (b.price / b.fiftyTwoWeekLow))
    .slice(0, 20);
  newLowsTable.setRows(newLows);

  const bulkDeal = mergedRows
    .filter((row) => Number.isFinite(row.relativeVolume))
    .sort((a, b) => b.relativeVolume - a.relativeVolume)
    .slice(0, 20);
  bulkDealTable.setRows(bulkDeal);
}

async function loadEarningsToday() {
  try {
    const response = await fetch("/api/earnings-calendar?days=1", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    const events = Array.isArray(payload.events) ? payload.events : [];
    earningsTodayHelper.textContent = events.length
      ? `${events.length} companies reporting today.`
      : "No confirmed earnings reports for today yet.";
    earningsTable.setRows(events);
  } catch (error) {
    earningsTodayHelper.textContent = error.message;
    earningsTable.setRows([]);
  }
}

async function loadNewsToday() {
  try {
    const response = await fetch("/api/news?symbols=&limit=12", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    const articles = Array.isArray(payload.articles) ? payload.articles : [];
    newsTodayHelper.textContent = articles.length ? `${articles.length} top market headlines.` : "No headlines found.";
    newsTodayList.innerHTML = articles.length
      ? articles.map((article) => {
          const tickers = Array.isArray(article.relatedTickers) && article.relatedTickers.length
            ? `<div class="news-tickers">${article.relatedTickers.slice(0, 6).map((ticker) => `<span>${escapeHtml(ticker)}</span>`).join("")}</div>`
            : "";
          const thumbnail = article.thumbnail
            ? `<img src="${escapeHtml(article.thumbnail)}" alt="">`
            : '<div class="news-thumb-placeholder"></div>';
          return `
            <article class="news-card">
              <a href="${escapeHtml(article.link)}" target="_blank" rel="noreferrer">
                ${thumbnail}
                <div>
                  <div class="news-meta">
                    <span>${escapeHtml(article.publisher || "Market news")}</span>
                    <span>${escapeHtml(timeAgo(article.publishedAt))}</span>
                  </div>
                  <h2>${escapeHtml(article.title)}</h2>
                  ${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ""}
                  ${tickers}
                </div>
              </a>
            </article>
          `;
        }).join("")
      : '<p class="loading">No headlines found.</p>';
  } catch (error) {
    newsTodayHelper.textContent = error.message;
    newsTodayList.innerHTML = '<p class="loading">Unable to load news.</p>';
  }
}

async function loadOverview() {
  if (isLoading) return;
  isLoading = true;
  setOverviewStatus("Loading", "live");
  const minPrice = Math.max(0, Number(overviewMinPrice.value) || 0);
  try {
    await Promise.all([loadStockSections(minPrice), loadEarningsToday(), loadNewsToday()]);
    setOverviewStatus("Live", "live");
  } catch (error) {
    setOverviewStatus("Error", "error");
  } finally {
    isLoading = false;
  }
}

overviewForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadOverview();
});
refreshOverview.addEventListener("click", loadOverview);

loadOverview();
