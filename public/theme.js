(function () {
  const STORAGE_KEY = "theme";

  function storedTheme() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === "dark" || value === "light" ? value : null;
    } catch {
      return null;
    }
  }

  function isDark() {
    const stored = storedTheme();
    if (stored) return stored === "dark";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyButton(button) {
    const dark = isDark();
    button.setAttribute("aria-pressed", String(dark));
    button.textContent = dark ? "☀️ Light" : "🌙 Dark";
    button.title = dark ? "Switch to light mode" : "Switch to dark mode";
  }

  function toggle() {
    const next = isDark() ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable (private mode, etc.) */
    }
    document.documentElement.setAttribute("data-theme", next);
    document.querySelectorAll("[data-theme-toggle]").forEach(applyButton);
  }

  function mount() {
    const host = document.querySelector(".topbar-actions") || document.querySelector(".topbar");
    if (!host || host.querySelector("[data-theme-toggle]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle";
    button.setAttribute("data-theme-toggle", "");
    applyButton(button);
    button.addEventListener("click", toggle);
    host.appendChild(button);
  }

  const ACCENT_KEY = "accentColor";

  function hexToRgb(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!match) return null;
    const value = match[1];
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
  }

  function resolvedAccentColor() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(raw);
    if (rgbMatch) {
      const [r, g, b] = rgbMatch[1].split(",").map((part) => parseFloat(part));
      if ([r, g, b].every(Number.isFinite)) return rgbToHex(r, g, b);
    }
    return hexToRgb(raw) ? raw : "#2f5f9f";
  }

  function storedAccent() {
    try {
      const value = localStorage.getItem(ACCENT_KEY);
      return hexToRgb(value) ? value : null;
    } catch {
      return null;
    }
  }

  function applyAccent(hex) {
    document.documentElement.style.setProperty("--accent", hex);
  }

  function setAccent(hex) {
    applyAccent(hex);
    try {
      localStorage.setItem(ACCENT_KEY, hex);
    } catch {
      /* localStorage unavailable */
    }
    document.querySelectorAll("[data-accent-picker]").forEach((input) => { input.value = hex; });
  }

  function mountAccentPicker() {
    const host = document.querySelector(".topbar-actions") || document.querySelector(".topbar");
    if (!host || host.querySelector("[data-accent-picker]")) return;
    const wrapper = document.createElement("label");
    wrapper.className = "accent-picker";
    wrapper.innerHTML = '<span>Accent color</span>';
    const input = document.createElement("input");
    input.type = "color";
    input.setAttribute("data-accent-picker", "");
    input.value = storedAccent() || resolvedAccentColor();
    input.addEventListener("input", () => setAccent(input.value));
    wrapper.appendChild(input);
    host.appendChild(wrapper);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      mount();
      mountAccentPicker();
    });
  } else {
    mount();
    mountAccentPicker();
  }

  window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!storedTheme()) document.querySelectorAll("[data-theme-toggle]").forEach(applyButton);
  });
}());
