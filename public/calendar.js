function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function formatEps(value) {
  if (!Number.isFinite(value)) return "--";
  return value.toFixed(2);
}

function formatSurprise(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function dateGroupKey(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "unknown";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatGroupHeading(key) {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return key;
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatTiming(event) {
  if (event.timing === "BMO") return "Before Open";
  if (event.timing === "AMC") return "After Close";
  if (event.timing === "TNS") return "Time TBD";
  if (!event.date) return event.timing || "--";
  const parsed = new Date(event.date);
  if (Number.isNaN(parsed.getTime())) return event.timing || "--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(parsed);
}

const calendarForm = document.getElementById("calendarForm");
const daysAheadSelect = document.getElementById("daysAheadSelect");
const timingSelect = document.getElementById("timingSelect");
const calendarQuery = document.getElementById("calendarQuery");
const resetCalendar = document.getElementById("resetCalendar");
const calendarStatus = document.getElementById("calendarStatus");
const calendarDot = document.getElementById("calendarDot");
const calendarCount = document.getElementById("calendarCount");
const calendarTodayCount = document.getElementById("calendarTodayCount");
const calendarBmoCount = document.getElementById("calendarBmoCount");
const calendarAmcCount = document.getElementById("calendarAmcCount");
const calendarHelper = document.getElementById("calendarHelper");
const calendarGroups = document.getElementById("calendarGroups");
const nextReportHint = document.getElementById("nextReportHint");

let isLoading = false;
let isLoadingHint = false;
let latestPayload = { startDate: null, endDate: null, count: 0, events: [] };

async function showNextConfirmedReport() {
  if (isLoadingHint) return;
  isLoadingHint = true;
  nextReportHint.hidden = false;
  nextReportHint.textContent = "Checking for the next confirmed report date...";
  try {
    const response = await fetch("/api/earnings-calendar?days=60", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    const upcoming = (payload.events || []).filter((event) => Date.parse(event.date) >= Date.now());
    if (!upcoming.length) {
      nextReportHint.textContent = "No confirmed report dates found in the next 60 days either.";
      return;
    }
    const next = upcoming[0];
    nextReportHint.innerHTML = `Next confirmed report: <a class="signal-link" href="/chart.html?symbol=${encodeURIComponent(next.symbol)}">${escapeHtml(next.symbol)}</a> (${escapeHtml(next.company || "")}) on ${escapeHtml(formatGroupHeading(dateGroupKey(next.date)))}.`;
  } catch (error) {
    nextReportHint.textContent = "";
    nextReportHint.hidden = true;
  } finally {
    isLoadingHint = false;
  }
}

function setCalendarStatus(text, state) {
  calendarStatus.textContent = text;
  calendarDot.classList.toggle("live", state === "live");
  calendarDot.classList.toggle("error", state === "error");
}

function renderCalendar(events) {
  if (!events.length) {
    const isLookback = daysAheadSelect.value === "today" || daysAheadSelect.value === "back3";
    calendarGroups.innerHTML = isLookback
      ? '<p class="helper-text">No companies reported earnings in this window.</p>'
      : '<p class="helper-text">No earnings events matched. Confirmed report dates are usually only published a few weeks out.</p>';
    showNextConfirmedReport();
    return;
  }
  nextReportHint.hidden = true;

  const groups = new Map();
  events.forEach((event) => {
    const key = dateGroupKey(event.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  });
  const sortedKeys = [...groups.keys()].sort();

  calendarGroups.innerHTML = sortedKeys.map((key) => {
    const rows = groups.get(key);
    return `
      <section class="calendar-group">
        <h2 class="calendar-date-heading">
          ${escapeHtml(formatGroupHeading(key))}
          <span class="calendar-date-count">${rows.length} ${rows.length === 1 ? "company" : "companies"}</span>
        </h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Company</th>
                <th>Timing</th>
                <th>EPS Est.</th>
                <th>EPS Actual</th>
                <th>Surprise</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((event) => `
                <tr>
                  <td class="symbol"><a class="signal-link" href="/chart.html?symbol=${encodeURIComponent(event.symbol)}">${escapeHtml(event.symbol)}</a></td>
                  <td>${escapeHtml(event.company || "--")}</td>
                  <td><span class="badge WATCH">${escapeHtml(formatTiming(event))}</span></td>
                  <td>${formatEps(event.epsEstimate)}</td>
                  <td>${formatEps(event.epsActual)}</td>
                  <td>${formatSurprise(event.epsSurprisePercent)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }).join("");
}

function applyFiltersAndRender() {
  const query = calendarQuery.value.trim().toLowerCase();
  const timing = timingSelect.value;
  const filtered = latestPayload.events.filter((event) => {
    if (timing && event.timing !== timing) return false;
    if (query) {
      const haystack = `${event.symbol} ${event.company || ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  calendarCount.textContent = filtered.length;
  const todayKey = dateGroupKey(new Date().toISOString());
  calendarTodayCount.textContent = filtered.filter((event) => dateGroupKey(event.date) === todayKey).length;
  calendarBmoCount.textContent = filtered.filter((event) => event.timing === "BMO").length;
  calendarAmcCount.textContent = filtered.filter((event) => event.timing === "AMC").length;

  calendarHelper.textContent = latestPayload.startDate
    ? `${filtered.length} of ${latestPayload.count} events from ${latestPayload.startDate} to ${latestPayload.endDate}.`
    : "";

  renderCalendar(filtered);
}

async function loadCalendar() {
  if (isLoading) return;
  isLoading = true;
  setCalendarStatus("Loading", "live");
  try {
    const rangeValue = daysAheadSelect.value;
    const params = rangeValue === "today"
      ? new URLSearchParams({ days: "0" })
      : rangeValue === "back3"
        ? new URLSearchParams({ daysBack: "3", days: "0" })
        : new URLSearchParams({ days: rangeValue });
    const response = await fetch(`/api/earnings-calendar?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    latestPayload = payload;
    applyFiltersAndRender();
    setCalendarStatus("Live", "live");
  } catch (error) {
    setCalendarStatus("Error", "error");
    calendarHelper.textContent = error.message;
    calendarGroups.innerHTML = "";
  } finally {
    isLoading = false;
  }
}

calendarForm.addEventListener("submit", (event) => {
  event.preventDefault();
  applyFiltersAndRender();
});

daysAheadSelect.addEventListener("change", loadCalendar);
timingSelect.addEventListener("change", applyFiltersAndRender);
calendarQuery.addEventListener("input", applyFiltersAndRender);

resetCalendar.addEventListener("click", () => {
  calendarForm.reset();
  loadCalendar();
});

loadCalendar();
