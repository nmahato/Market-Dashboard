const newsForm = document.getElementById("newsForm");
const newsQuery = document.getElementById("newsQuery");
const clearNews = document.getElementById("clearNews");
const watchlistNews = document.getElementById("watchlistNews");
const newsList = document.getElementById("newsList");
const newsStatus = document.getElementById("newsStatus");
const newsDot = document.getElementById("newsDot");
const newsCountdown = document.getElementById("newsCountdown");
const newsCount = document.getElementById("newsCount");
const newsUpdated = document.getElementById("newsUpdated");
const newsHelper = document.getElementById("newsHelper");

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

function setStatus(text, state) {
  newsStatus.textContent = text;
  newsDot.classList.toggle("live", state === "live");
  newsDot.classList.toggle("error", state === "error");
}

function renderNews(payload) {
  const articles = Array.isArray(payload.articles) ? payload.articles : [];
  newsCount.textContent = articles.length;
  newsUpdated.textContent = formatTime(payload.updatedAt);
  newsHelper.textContent = payload.query
    ? `Showing headlines for "${payload.query}".`
    : "Showing latest market and watchlist headlines.";

  if (!articles.length) {
    newsList.innerHTML = '<p class="loading">No headlines found.</p>';
    return;
  }

  newsList.innerHTML = articles.map((article) => {
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

async function loadNews() {
  if (isLoading) return;
  isLoading = true;
  setStatus("Refreshing", "live");

  const params = new URLSearchParams();
  const query = newsQuery.value.trim();
  if (query) params.set("q", query);
  if (!watchlistNews.checked) params.set("symbols", "");

  try {
    const response = await fetch(`/api/news?${params.toString()}`, {
      cache: "no-store"
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    renderNews(payload);
    setStatus("Live", "live");
    countdown = refreshSeconds;
  } catch (error) {
    setStatus("Error", "error");
    newsHelper.textContent = error.message;
  } finally {
    isLoading = false;
  }
}

function startTimers() {
  clearInterval(countdownTimer);
  clearInterval(refreshTimer);
  countdownTimer = setInterval(() => {
    countdown = Math.max(0, countdown - 1);
    newsCountdown.textContent = `${countdown}s`;
  }, 1000);
  refreshTimer = setInterval(loadNews, refreshSeconds * 1000);
}

newsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  countdown = refreshSeconds;
  loadNews();
});

clearNews.addEventListener("click", () => {
  newsQuery.value = "";
  watchlistNews.checked = true;
  countdown = refreshSeconds;
  loadNews();
});

watchlistNews.addEventListener("change", () => {
  countdown = refreshSeconds;
  loadNews();
});

startTimers();
loadNews();
