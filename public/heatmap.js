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

function readCssVar(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return { r: 128, g: 128, b: 128 };
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  };
}

function mixColor(from, to, ratio) {
  const r = Math.round(from.r + (to.r - from.r) * ratio);
  const g = Math.round(from.g + (to.g - from.g) * ratio);
  const b = Math.round(from.b + (to.b - from.b) * ratio);
  return `rgb(${r}, ${g}, ${b})`;
}

const CHANGE_CAP = 5;

function colorForChange(changePercent, neutralRgb, hotRgb, buyRgb) {
  if (!Number.isFinite(changePercent)) return `rgb(${neutralRgb.r}, ${neutralRgb.g}, ${neutralRgb.b})`;
  const clamped = Math.max(-CHANGE_CAP, Math.min(CHANGE_CAP, changePercent));
  if (clamped >= 0) return mixColor(neutralRgb, buyRgb, clamped / CHANGE_CAP);
  return mixColor(neutralRgb, hotRgb, -clamped / CHANGE_CAP);
}

const heatmapForm = document.getElementById("heatmapForm");
const heatmapMinPrice = document.getElementById("heatmapMinPrice");
const refreshHeatmap = document.getElementById("refreshHeatmap");
const heatmapStatus = document.getElementById("heatmapStatus");
const heatmapDot = document.getElementById("heatmapDot");
const heatmapHelper = document.getElementById("heatmapHelper");
const heatmapGrid = document.getElementById("heatmapGrid");

let isLoading = false;

function setHeatmapStatus(text, state) {
  heatmapStatus.textContent = text;
  heatmapDot.classList.toggle("live", state === "live");
  heatmapDot.classList.toggle("error", state === "error");
}

async function fetchScreener(preset, minPrice, limit = 50) {
  const params = new URLSearchParams({ preset, minPrice, limit });
  const response = await fetch(`/api/screener?${params.toString()}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
  return Array.isArray(payload.data) ? payload.data : [];
}

function renderHeatmap(rows) {
  if (!rows.length) {
    heatmapGrid.innerHTML = "";
    heatmapHelper.textContent = "No matches right now.";
    return;
  }

  const neutralRgb = hexToRgb("#5a6472");
  const hotRgb = hexToRgb(readCssVar("--hot", "#aa2e25"));
  const buyRgb = hexToRgb(readCssVar("--buy", "#0f8a5f"));

  const marketCaps = rows.map((row) => Math.max(1, row.marketCap || 0));
  const logCaps = marketCaps.map((cap) => Math.log10(cap + 10));
  const minLog = Math.min(...logCaps);
  const maxLog = Math.max(...logCaps);
  const range = maxLog - minLog || 1;

  heatmapGrid.innerHTML = rows.map((row, index) => {
    const weight = 1 + ((logCaps[index] - minLog) / range) * 8;
    const background = colorForChange(row.todayChangePercent, neutralRgb, hotRgb, buyRgb);
    return `
      <a class="heatmap-tile" style="flex-grow: ${weight.toFixed(2)}; background: ${background};"
         href="/chart.html?symbol=${encodeURIComponent(row.symbol)}" title="${escapeHtml(row.name || row.symbol)}">
        <strong>${escapeHtml(row.symbol)}</strong>
        <span>${formatPercent(row.todayChangePercent)}</span>
        <small>${formatMoney(row.price)}</small>
      </a>
    `;
  }).join("");

  heatmapHelper.textContent = `${rows.length} stocks. Tile size = market cap, color = today's % change (capped at ±${CHANGE_CAP}%).`;
}

async function loadHeatmap() {
  if (isLoading) return;
  isLoading = true;
  setHeatmapStatus("Loading", "live");
  const minPrice = Math.max(0, Number(heatmapMinPrice.value) || 0);
  try {
    const [mostActive, gainers, losers] = await Promise.all([
      fetchScreener("most-active", minPrice, 50),
      fetchScreener("top-gainers", minPrice, 50),
      fetchScreener("top-losers", minPrice, 50)
    ]);
    const merged = new Map();
    [...mostActive, ...gainers, ...losers].forEach((row) => {
      if (row && row.symbol && row.state !== "ERROR") merged.set(row.symbol, row);
    });
    renderHeatmap([...merged.values()].sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)));
    setHeatmapStatus("Live", "live");
  } catch (error) {
    setHeatmapStatus("Error", "error");
    heatmapHelper.textContent = error.message;
    heatmapGrid.innerHTML = "";
  } finally {
    isLoading = false;
  }
}

heatmapForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadHeatmap();
});
refreshHeatmap.addEventListener("click", loadHeatmap);

loadHeatmap();
