const moversStatus = document.getElementById("moversStatus");
const moversDot = document.getElementById("moversDot");
const moversCountdown = document.getElementById("moversCountdown");
const moversUpdated = document.getElementById("moversUpdated");
const gainerCount = document.getElementById("gainerCount");
const loserCount = document.getElementById("loserCount");
const moversNewsCount = document.getElementById("moversNewsCount");
const gainerMeta = document.getElementById("gainerMeta");
const loserMeta = document.getElementById("loserMeta");
const gainerRows = document.getElementById("gainerRows");
const loserRows = document.getElementById("loserRows");
const moversNewsMeta = document.getElementById("moversNewsMeta");
const moversNewsList = document.getElementById("moversNewsList");

const MOVERS_LIMIT = 10;
const refreshSeconds = 60;
let countdown = refreshSeconds;
let countdownTimer;
let refreshTimer;
let isLoading = false;

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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function formatVolume(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatTime(value) {
  if (!value) return "--";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(parsed);
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

function stateClass(value) {
  return String(value || "ERROR").replace(" ", "_");
}

function setStatus(text, state) {
  moversStatus.textContent = text;
  moversDot.classList.toggle("live", state === "live");
  moversDot.classList.toggle("error", state === "error");
}

function renderMoverRows(tbody, rows) {
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="loading">No data available.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((row) => {
    const changeClass = Number.isFinite(row.todayChangePercent)
      ? (row.todayChangePercent >= 0 ? "positive" : "negative")
      : "neutral";
    return `
      <tr>
        <td class="symbol"><a class="signal-link" href="/indicator.html?symbol=${encodeURIComponent(row.symbol)}">${escapeHtml(row.symbol)}</a></td>
        <td>${formatMoney(row.price)}</td>
        <td><span class="change ${changeClass}">${formatPercent(row.todayChangePercent)}</span></td>
        <td>${formatVolume(row.volume)}</td>
        <td><span class="badge ${stateClass(row.state)}">${escapeHtml(row.state || "ERROR")}</span></td>
      </tr>
    `;
  }).join("");
}

function renderNews(articles) {
  if (!articles.length) {
    moversNewsList.innerHTML = '<p class="loading">No headlines found.</p>';
    return;
  }

  moversNewsList.innerHTML = articles.map((article) => {
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
  }).join("");
}

async function fetchScreener(preset) {
  const params = new URLSearchParams({ preset, sort: "change", limit: String(MOVERS_LIMIT) });
  const response = await fetch(`/api/screener?${params.toString()}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

async function fetchTopNews() {
  const params = new URLSearchParams({ symbols: "", limit: String(MOVERS_LIMIT) });
  const response = await fetch(`/api/news?${params.toString()}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return payload;
}

async function loadMovers() {
  if (isLoading) return;
  isLoading = true;
  setStatus("Refreshing", "live");

  try {
    const [gainers, losers, news] = await Promise.all([
      fetchScreener("top-gainers"),
      fetchScreener("top-losers"),
      fetchTopNews()
    ]);

    const gainerData = Array.isArray(gainers.data) ? gainers.data : [];
    // The API always sorts "change" descending; reverse so the biggest losers lead.
    const loserData = Array.isArray(losers.data) ? [...losers.data].reverse() : [];
    const articles = Array.isArray(news.articles) ? news.articles : [];

    gainerCount.textContent = gainerData.length;
    loserCount.textContent = loserData.length;
    moversNewsCount.textContent = articles.length;
    moversUpdated.textContent = formatTime(gainers.updatedAt);

    gainerMeta.textContent = `${gainerData.length} from ${gainers.source}`;
    loserMeta.textContent = `${loserData.length} from ${losers.source}`;
    moversNewsMeta.textContent = `Updated ${formatTime(news.updatedAt)}`;

    renderMoverRows(gainerRows, gainerData);
    renderMoverRows(loserRows, loserData);
    renderNews(articles);

    setStatus("Live", "live");
    countdown = refreshSeconds;
  } catch (error) {
    setStatus("Error", "error");
    gainerMeta.textContent = error.message;
    loserMeta.textContent = error.message;
    moversNewsMeta.textContent = error.message;
  } finally {
    isLoading = false;
  }
}

function startTimers() {
  clearInterval(countdownTimer);
  clearInterval(refreshTimer);
  countdownTimer = setInterval(() => {
    countdown = Math.max(0, countdown - 1);
    moversCountdown.textContent = `${countdown}s`;
  }, 1000);
  refreshTimer = setInterval(loadMovers, refreshSeconds * 1000);
}

startTimers();
loadMovers();
