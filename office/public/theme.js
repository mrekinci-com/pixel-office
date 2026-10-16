// Load the theme before first paint without weakening content security.
try {
  const theme = localStorage.getItem("po-tema");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch { /* Use the system preference when storage is unavailable. */ }
// Match the mobile browser toolbar to the selected surface color.
const updateThemeColor = () => {
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (meta && color) meta.setAttribute('content', color);
};
document.addEventListener('DOMContentLoaded', updateThemeColor);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateThemeColor);
new MutationObserver(updateThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
