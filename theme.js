"use strict";

const themeKey = "presence-theme";
let storedTheme = null;
try {
  storedTheme = localStorage.getItem(themeKey);
} catch {
  storedTheme = null;
}
const initialTheme = storedTheme === "light" || storedTheme === "dark"
  ? storedTheme
  : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === "dark" ? "#111821" : "#f6f8fb";
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
    button.setAttribute("aria-pressed", String(theme === "dark"));
    const label = button.querySelector("[data-theme-label]");
    const icon = button.querySelector("[data-theme-icon]");
    if (label) label.textContent = theme === "dark" ? "Light" : "Dark";
    if (icon) icon.textContent = theme === "dark" ? "☀" : "☾";
  });
}

applyTheme(initialTheme);

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(themeKey, theme);
      } catch {
        button.title = "Theme preference could not be saved in this browser.";
      }
      applyTheme(theme);
    });
  });
});
