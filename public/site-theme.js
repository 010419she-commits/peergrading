/* Apply appearance before CSS. Only public-site appearance is stored here. */
(() => {
  "use strict";
  const key = "peergrading-site-theme";
  const valid = (value) => value === "light" || value === "dark";
  const read = () => { try { return localStorage.getItem(key); } catch { return null; } };
  let system;
  try { system = window.matchMedia("(prefers-color-scheme: dark)"); } catch {}
  const preferred = () => system?.matches ? "dark" : "light";
  let saved = read();
  let theme = valid(saved) ? saved : preferred();
  function apply(value, { persist = true } = {}) {
    if (!valid(value)) return theme;
    theme = value;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#181b1c" : "#f7f7f2");
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
    if (persist) { saved = theme; try { localStorage.setItem(key, theme); } catch {} }
    window.dispatchEvent(new CustomEvent("site-theme-change", { detail: theme }));
    return theme;
  }
  window.PeerGradingSiteTheme = { current: () => theme, apply, toggle: () => apply(theme === "light" ? "dark" : "light") };
  apply(theme, { persist: false });
  const followSystem = () => { if (!valid(saved)) apply(preferred(), { persist: false }); };
  if (typeof system?.addEventListener === "function") system.addEventListener("change", followSystem);
  else system?.addListener?.(followSystem);
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    saved = read();
    apply(valid(saved) ? saved : preferred(), { persist: false });
  });
})();
