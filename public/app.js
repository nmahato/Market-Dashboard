const rows = document.getElementById("rows");
const statusText = document.getElementById("statusText");
const connectionDot = document.getElementById("connectionDot");
const countdown = document.getElementById("countdown");
const signalCount = document.getElementById("signalCount");
const oversoldCount = document.getElementById("oversoldCount");
const extendedCount = document.getElementById("extendedCount");
const updatedAt = document.getElementById("updatedAt");

const refreshSeconds = 15;
let nextRefresh = refreshSeconds;

function formatMoney(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function formatTime(value) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function render(data) {
  const items = data.data || [];
  const signals = items.filter((item) => item.state === "BUY SIGNAL").length;
  const oversold = items.filter((item) => item.state === "OVERSOLD").length;
  const extended = items.filter((item) => item.state === "EXTENDED").length;

  signalCount.textContent = signals;
  oversoldCount.textContent = oversold;
  extendedCount.textContent = extended;
  updatedAt.textContent = formatTime(data.updatedAt);

  rows.innerHTML = items
    .map((item) => {
      const stateClass = String(item.state || "ERROR").replace(" ", "_");
      return `
        <tr>
          <td class="symbol">${item.symbol}</td>
          <td>${formatMoney(item.price)}</td>
          <td class="rsi">${Number.isFinite(item.rsi) ? item.rsi.toFixed(2) : "--"}</td>
          <td class="rsi">${Number.isFinite(item.previousRsi) ? item.previousRsi.toFixed(2) : "--"}</td>
          <td><span class="badge ${stateClass}">${item.state || "ERROR"}</span></td>
        </tr>
      `;
    })
    .join("");
}

async function loadData() {
  statusText.textContent = "Refreshing";
  try {
    const response = await fetch("/api/market", { cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const data = await response.json();
    render(data);
    statusText.textContent = "Live";
    connectionDot.className = "dot live";
  } catch (error) {
    statusText.textContent = "Data error";
    connectionDot.className = "dot error";
    rows.innerHTML = `<tr><td colspan="5" class="loading">${error.message}</td></tr>`;
  } finally {
    nextRefresh = refreshSeconds;
  }
}

setInterval(() => {
  nextRefresh -= 1;
  if (nextRefresh <= 0) {
    loadData();
  }
  countdown.textContent = `${Math.max(nextRefresh, 0)}s`;
}, 1000);

loadData();
