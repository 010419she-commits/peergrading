// Runs before styles so the first frame uses the chosen appearance.
(() => {
  const key = "peergrading-theme";
  const valid = (value) => value === "light" || value === "dark";
  let theme;
  try { theme = window.peergrading?.theme; } catch {}
  if (!valid(theme)) {
    try { theme = localStorage.getItem(key); } catch {}
  }
  if (!valid(theme)) {
    try { theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
    catch { theme = "light"; }
  }
  function apply(value, { persist = true } = {}) {
    if (!valid(value)) return theme;
    theme = value;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = theme;
    if (persist) {
      try { localStorage.setItem(key, theme); } catch {}
      try { window.peergrading?.setTheme(theme)?.catch(() => {}); } catch {}
    }
    return theme;
  }
  window.PeerGradingTheme = { current: () => theme, apply, toggle: () => apply(theme === "light" ? "dark" : "light") };
  apply(theme, { persist: false });
})();
