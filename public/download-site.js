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
  document.getElementById("year").textContent = String(new Date().getFullYear());

  const downloads = document.getElementById("downloads");
  const safeInstaller = (item) => {
    if (!item || typeof item.file !== "string" || typeof item.url !== "string" || !Number.isFinite(item.size) || item.size <= 0) return null;
    try {
      const url = new URL(item.url, location.origin);
      if (url.origin !== location.origin || !url.pathname.startsWith("/download/")) return null;
      return { ...item, url: url.href, version: typeof item.version === "string" ? item.version : "" };
    } catch { return null; }
  };
  const platformCard = (name, subtitle, installers, mac) => {
    const available = installers.filter(([, item]) => item);
    const card = make("article", { className: "plan download-card" + (available.length ? " featured" : "") });
    card.append(make("div", { className: "download-card-heading" }, make("span", { className: "platform-symbol", textContent: mac ? "⌘" : "⊞", ariaHidden: "true" }), make("h3", { textContent: name })), make("p", { className: "muted", textContent: subtitle }));
    const links = make("div", { className: "installer-links" });
    for (const [label, item] of available) {
      const button = make("a", { className: "button button-primary", href: item.url, textContent: `${t("downloadBtn")(item.version)}${label ? " · " + label : ""}` });
      links.append(make("div", { className: "installer" }, button, make("p", { className: "fine installer-file", textContent: `${item.file} · ${Math.round(item.size / 1048576)} MB` })));
    }
    if (!available.length) links.append(make("p", { className: "muted", textContent: t("dlSoon") }));
    card.append(links);
    if (available.length && mac) {
      const details = make("details", { className: "install-help" });
      details.append(make("summary", { textContent: lang === "zh" ? "macOS 安装提示" : "macOS installation note" }), make("p", { textContent: t("dlMacGatekeeper") }), make("code", { textContent: "xattr -cr /Applications/PeerGrading.app" }));
      card.append(details);
    }
    return card;
  };
  async function loadDownloads() {
    downloads.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/download/latest", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("download_unavailable");
      const data = await response.json();
      if (!data || !["macArm", "macIntel", "win"].some((key) => Object.hasOwn(data, key))) throw new Error("invalid_downloads");
      downloads.replaceChildren(
        platformCard(t("dlMac"), t("dlMacSub"), [[t("dlApple"), safeInstaller(data.macArm)], [t("dlIntel"), safeInstaller(data.macIntel)]], true),
        platformCard(t("dlWin"), t("dlWinSub"), [["", safeInstaller(data.win)]], false),
      );
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
