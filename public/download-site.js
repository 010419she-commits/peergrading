/* Download website: product copy, language, installers and navigation only. */
(() => {
  "use strict";
  const dictionaries = window.SITE_I18N || {};
  const lang = (() => {
    try {
      const saved = localStorage.getItem("lang");
      if (saved === "zh" || saved === "en") return saved;
    } catch {}
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  })();
  const t = (key) => dictionaries[lang]?.[key] ?? dictionaries.zh?.[key] ?? key;
  const make = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    Object.assign(node, props); node.append(...children); return node;
  };
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = t("homePageTitle");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("homeDescription"));
  document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach((node) => { node.innerHTML = t(node.dataset.i18nHtml); });
  document.querySelectorAll("[data-i18n-aria]").forEach((node) => { node.setAttribute("aria-label", t(node.dataset.i18nAria)); });
  document.querySelectorAll(".lang-seg button").forEach((button) => {
    const selected = button.dataset.lang === lang;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", () => {
      if (selected) return;
      try { localStorage.setItem("lang", button.dataset.lang); } catch { return; }
      location.reload();
    });
  });
  const themeButton = document.getElementById("site-theme-toggle");
  const updateThemeButton = () => {
    if (!themeButton) return;
    const dark = document.documentElement.dataset.theme === "dark";
    const label = t(dark ? "themeToLight" : "themeToDark");
    themeButton.setAttribute("aria-label", label);
    themeButton.setAttribute("title", label);
    themeButton.setAttribute("aria-pressed", String(dark));
  };
  if (themeButton && window.PeerGradingSiteTheme) {
    themeButton.addEventListener("click", () => window.PeerGradingSiteTheme.toggle());
    window.addEventListener("site-theme-change", updateThemeButton);
    updateThemeButton();
  }
  document.getElementById("year").textContent = String(new Date().getFullYear());

  const downloads = document.getElementById("downloads");
  const fallback = document.getElementById("download-fallback");
  const REPO = "010419she-commits/peergrading";
  const SOURCE_URL = `https://github.com/${REPO}`;
  const RELEASES_URL = `${SOURCE_URL}/releases`;
  const externalLink = (key, href) => make("a", { className: "text-link", href, target: "_blank", rel: "noopener noreferrer", textContent: t(key) });
  fallback.replaceChildren(externalLink("sourceCode", SOURCE_URL), externalLink("allReleases", RELEASES_URL));

  const safeInstaller = (item, version) => {
    if (!item || typeof item.name !== "string" || typeof item.url !== "string" || typeof item.platform !== "string" || typeof item.arch !== "string") return null;
    if (!["macos", "windows"].includes(item.platform) || !/^[A-Za-z0-9._-]{1,80}$/.test(item.arch)) return null;
    if (!item.name || item.name.length > 255 || item.name !== item.name.trim() || /[\/\\\u0000-\u001f]/.test(item.name)) return null;
    if (item.size !== undefined && (!Number.isFinite(item.size) || item.size <= 0)) return null;
    if (item.sha256 !== undefined && (typeof item.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(item.sha256))) return null;
    try {
      const url = new URL(item.url);
      if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      const prefix = [...REPO.split("/"), "releases", "download"];
      if (parts.length !== prefix.length + 2 || !prefix.every((part, index) => parts[index] === part)) return null;
      if (parts[prefix.length] !== version && parts[prefix.length] !== `v${version}`) return null;
      if (decodeURIComponent(parts.at(-1)) !== item.name) return null;
      return { name: item.name, url: url.href, platform: item.platform, arch: item.arch, size: item.size ?? null, sha256: item.sha256?.toLowerCase() || "" };
    } catch { return null; }
  };
  const formatSize = (bytes) => {
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes, unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en", { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
  };
  const platformCard = (platform, installers, version) => {
    const card = make("article", { className: "plan download-card" + (installers.length ? " featured" : "") });
    const mac = platform === "macos";
    card.append(make("div", { className: "download-card-heading" }, make("span", { className: "platform-symbol", textContent: mac ? "⌘" : "⊞", ariaHidden: "true" }), make("h3", { textContent: t(mac ? "dlMac" : "dlWin") })), make("p", { className: "muted", textContent: t(mac ? "dlMacSub" : "dlWinSub") }));
    const links = make("div", { className: "installer-links" });
    for (const item of installers) {
      const button = make("a", { className: "button button-primary", href: item.url, textContent: `${t("downloadBtn")(version)} · ${item.arch}` });
      const metadata = make("dl", { className: "installer-meta" });
      const addMetadata = (label, value, code = false) => {
        const row = make("div", { className: "installer-meta-row" });
        row.append(make("dt", { textContent: label }), make("dd", { textContent: value }));
        if (code) row.classList.add("installer-sha");
        metadata.append(row);
      };
      addMetadata(t("dlVersion"), version);
      addMetadata(t("dlArchitecture"), item.arch);
      if (item.size) addMetadata(t("dlSize"), formatSize(item.size));
      if (item.sha256) addMetadata(t("dlSha256"), item.sha256, true);
      const details = make("details", { className: "installer-details" }, make("summary", { textContent: t("dlDetails") }), metadata);
      links.append(make("div", { className: "installer" }, button, make("p", { className: "fine installer-file", textContent: item.name }), details));
    }
    if (!installers.length) links.append(make("p", { className: "muted", textContent: t("dlSoon") }));
    card.append(links);
    return card;
  };
  async function loadDownloads() {
    downloads.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/installers.json", { headers: { accept: "application/json" }, cache: "no-cache" });
      if (!response.ok) throw new Error("download_unavailable");
      const data = await response.json();
      if (!data || data.repo !== REPO || typeof data.version !== "string" || !/^\d+\.\d+\.\d+$/.test(data.version) || !Array.isArray(data.assets)) throw new Error("invalid_downloads");
      const assets = data.assets.map((item) => safeInstaller(item, data.version)).filter(Boolean);
      const rejected = data.assets.length - assets.length;
      downloads.replaceChildren(
        platformCard("macos", assets.filter((item) => item.platform === "macos"), data.version),
        platformCard("windows", assets.filter((item) => item.platform === "windows"), data.version),
      );
      if (rejected) downloads.append(make("p", { className: "notice download-validation", textContent: t("dlInvalid") }));
    } catch {
      const retry = make("button", { className: "button small", type: "button", textContent: t("homeRetryDownload") });
      retry.addEventListener("click", () => { retry.disabled = true; loadDownloads(); });
      downloads.replaceChildren(make("div", { className: "notice download-error" }, make("p", { textContent: t("homeDownloadsFailed") }), retry));
    } finally { downloads.setAttribute("aria-busy", "false"); }
  }
  loadDownloads();

  const root = document.documentElement;
  const header = document.getElementById("site-header");
  const updateAnchorOffset = () => root.style.setProperty("--anchor-offset", `${Math.ceil(header.getBoundingClientRect().height) + 24}px`);
  updateAnchorOffset();
  if ("ResizeObserver" in window) new ResizeObserver(updateAnchorOffset).observe(header);
  else window.addEventListener("resize", updateAnchorOffset, { passive: true });
  const dialog = document.getElementById("mobile-menu");
  const toggle = document.getElementById("menu-toggle");
  const closeButton = document.getElementById("menu-close");
  const primaryNav = document.getElementById("primary-nav");
  const desktop = window.matchMedia("(min-width: 1100px)");
  if (typeof window.HTMLDialogElement === "undefined" || typeof dialog.showModal !== "function") return;
  const syncClosedState = () => {
    if (dialog.open) return;
    toggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("menu-open");
  };
  const closeMenu = () => { if (dialog.open) dialog.close(); syncClosedState(); };
  toggle.addEventListener("click", () => {
    if (desktop.matches || dialog.open) return;
    try { dialog.showModal(); toggle.setAttribute("aria-expanded", "true"); document.body.classList.add("menu-open"); closeButton.focus(); }
    catch { closeMenu(); root.classList.remove("menu-ready"); toggle.hidden = true; updateAnchorOffset(); primaryNav.querySelector("a").focus(); }
  });
  closeButton.addEventListener("click", closeMenu);
  dialog.addEventListener("close", syncClosedState);
  dialog.querySelectorAll('a[href^="#"]').forEach((link) => link.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(link.hash.slice(1));
    closeMenu(); if (target) target.focus({ preventScroll: true });
  }));
  const onBreakpointChange = (event) => {
    if (!event.matches) return;
    const needsFocus = dialog.open || document.activeElement === toggle;
    closeMenu(); updateAnchorOffset();
    if (needsFocus) primaryNav.querySelector("a").focus({ preventScroll: true });
  };
  if (typeof desktop.addEventListener === "function") desktop.addEventListener("change", onBreakpointChange);
  else desktop.addListener(onBreakpointChange);
  window.addEventListener("pagehide", closeMenu);
  window.addEventListener("pageshow", () => { syncClosedState(); updateAnchorOffset(); });
  toggle.hidden = false; root.classList.add("menu-ready"); updateAnchorOffset();
})();
