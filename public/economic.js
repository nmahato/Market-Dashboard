function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function dateGroupKey(dateString) {
  return dateString || "unknown";
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

function formatEventTime(event) {
  if (!event.time) return "--";
  const [hours, minutes] = event.time.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return event.time;
  const utcDate = new Date(Date.UTC(1970, 0, 1, hours, minutes));
  return `${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(utcDate)} (GMT)`;
}

const econCalendarForm = document.getElementById("econCalendarForm");
const econDaysAheadSelect = document.getElementById("econDaysAheadSelect");
const econCountrySelect = document.getElementById("econCountrySelect");
const econCalendarQuery = document.getElementById("econCalendarQuery");
const resetEconCalendar = document.getElementById("resetEconCalendar");
const econCalendarStatus = document.getElementById("econCalendarStatus");
const econCalendarDot = document.getElementById("econCalendarDot");
const econCalendarCount = document.getElementById("econCalendarCount");
const econCalendarTodayCount = document.getElementById("econCalendarTodayCount");
const econCalendarCountryCount = document.getElementById("econCalendarCountryCount");
const econCalendarHelper = document.getElementById("econCalendarHelper");
const econCalendarGroups = document.getElementById("econCalendarGroups");

let isLoading = false;
let latestPayload = { startDate: null, endDate: null, count: 0, events: [] };

function setEconCalendarStatus(text, state) {
  econCalendarStatus.textContent = text;
  econCalendarDot.classList.toggle("live", state === "live");
  econCalendarDot.classList.toggle("error", state === "error");
}

function renderEconCalendar(events) {
  if (!events.length) {
    econCalendarGroups.innerHTML = '<p class="helper-text">No economic events matched this filter.</p>';
    return;
  }

  const groups = new Map();
  events.forEach((event) => {
    const key = dateGroupKey(event.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  });
  const sortedKeys = [...groups.keys()].sort();

  econCalendarGroups.innerHTML = sortedKeys.map((key) => {
    const rows = groups.get(key);
    return `
      <section class="calendar-group">
        <h2 class="calendar-date-heading">
          ${escapeHtml(formatGroupHeading(key))}
          <span class="calendar-date-count">${rows.length} ${rows.length === 1 ? "event" : "events"}</span>
        </h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Country</th>
                <th>Event</th>
                <th>Consensus</th>
                <th>Previous</th>
                <th>Actual</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((event) => `
                <tr>
                  <td>${escapeHtml(formatEventTime(event))}</td>
                  <td><span class="badge WATCH">${escapeHtml(event.country)}</span></td>
                  <td title="${escapeHtml(event.description || "")}">${escapeHtml(event.event)}</td>
                  <td>${escapeHtml(event.consensus || "--")}</td>
                  <td>${escapeHtml(event.previous || "--")}</td>
                  <td>${escapeHtml(event.actual || "--")}</td>
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
  const query = econCalendarQuery.value.trim().toLowerCase();
  const filtered = latestPayload.events.filter((event) => {
    if (!query) return true;
    const haystack = `${event.event} ${event.country}`.toLowerCase();
    return haystack.includes(query);
  });

  econCalendarCount.textContent = filtered.length;
  const todayKey = dateGroupKey(new Date().toISOString().slice(0, 10));
  econCalendarTodayCount.textContent = filtered.filter((event) => event.date === todayKey).length;
  econCalendarCountryCount.textContent = new Set(filtered.map((event) => event.country)).size;

  econCalendarHelper.textContent = latestPayload.startDate
    ? `${filtered.length} of ${latestPayload.count} events from ${latestPayload.startDate} to ${latestPayload.endDate}.`
    : "";

  renderEconCalendar(filtered);
}

async function loadEconCalendar() {
  if (isLoading) return;
  isLoading = true;
  setEconCalendarStatus("Loading", "live");
  try {
    const params = new URLSearchParams({
      days: econDaysAheadSelect.value,
      country: econCountrySelect.value
    });
    const response = await fetch(`/api/economic-calendar?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    latestPayload = payload;
    applyFiltersAndRender();
    setEconCalendarStatus("Live", "live");
  } catch (error) {
    setEconCalendarStatus("Error", "error");
    econCalendarHelper.textContent = error.message;
    econCalendarGroups.innerHTML = "";
  } finally {
    isLoading = false;
  }
}

econCalendarForm.addEventListener("submit", (event) => {
  event.preventDefault();
  applyFiltersAndRender();
});

econDaysAheadSelect.addEventListener("change", loadEconCalendar);
econCountrySelect.addEventListener("change", loadEconCalendar);
econCalendarQuery.addEventListener("input", applyFiltersAndRender);

resetEconCalendar.addEventListener("click", () => {
  econCalendarForm.reset();
  loadEconCalendar();
});

loadEconCalendar();
