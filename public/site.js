/* site.js — 登录态 / 登录弹窗 / 定价与购买 / 账号页（按 v9 §7.4 改写） */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, p = {}, ...k) => { const n = document.createElement(t); Object.assign(n, p); n.append(...k); return n; };
  const hidden = (name, value) => el("input", { type: "hidden", name, value });
  const L = window.SITE_I18N || {};
  const lang = (() => { try { return localStorage.getItem("lang") || (navigator.language.startsWith("zh") ? "zh" : "en"); } catch { return "zh"; } })();
  const t = (k) => (L[lang] || {})[k] ?? (L.zh || {})[k] ?? k;   // 函数型文案由调用方传参调用

  const S = { status: "loading", user: null, providers: null, plan: null, csrf: "", returnTo: initialReturnTo() };
  const dialog = $("#login-modal"), toastEl = $("#toast");
  let lastFocus = null, paymentPoll = null, pollingOrder = null;

  function initialReturnTo() {
    const p = new URLSearchParams(location.search).get("return_to");
    if (p && /^\/(account|app|admin|device(\?code=[A-Z0-9-]{1,12})?)?(#[\w-]{1,40})?$/.test(p)) return p;
    if (location.pathname === "/device") return "/device" + (location.search.match(/^\?code=[A-Z0-9-]{1,12}$/) ? location.search : "");
    return /^\/(account|app|admin)?$/.test(location.pathname) ? location.pathname + location.hash : "/app";
  }
  function toast(msg, ms = 4000) { if (!toastEl) return; toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (toastEl.hidden = true), ms); }
  async function postJson(url, body) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": S.csrf, accept: "application/json" }, body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, ...d };
    } catch { return { ok: false, status: 0, error: "network" }; }
  }
  const busy = (btn, fn) => async () => { if (btn.disabled) return; btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
  const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-US");
  const fmtMoney = (cents, cur) => (cur === "CNY" ? "¥" : cur + " ") + (cents / 100).toFixed(2).replace(/\.00$/, "");

  async function bootstrap() {
    clearTimeout(paymentPoll); pollingOrder = null;
    S.status = "loading";
    try {
      const r = await fetch("/api/auth/bootstrap", { headers: { accept: "application/json" } });
      if (!r.ok) throw 0;
      const d = await r.json();
      S.user = d.user; S.providers = d.providers; S.csrf = d.csrf; S.status = d.status; S.plan = d.plan; S.webWorkspace = !!d.webWorkspace;
    } catch { S.status = "failed"; }
    renderAll();
  }
  function renderAll() { applyI18n(); renderNav(); renderPricing(); renderAccount(); renderDevicePage(); if (dialog?.open) renderLoginForms(dialog.dataset.intent || "login"); }

  /* ---------- 桌面软件配对页 ---------- */
  function renderDevicePage() {
    const root = $("#device-root"); if (!root) return;
    const input = $("#device-code"), status = $("#device-status");
    const q = new URLSearchParams(location.search).get("code"); if (q && !input.value) input.value = q;
    if (S.status === "anonymous") { status.hidden = false; status.textContent = t("deviceNeedLogin"); openLogin({ returnTo: "/device" + (q ? "?code=" + q : "") }); return; }
    status.hidden = true;
    const post = async (path) => {
      const r = await postJson(path, { userCode: input.value.trim() });
      status.hidden = false; status.className = "notice " + (r.ok ? "ok" : "warn");
      status.textContent = r.ok ? (path.endsWith("approve") ? t("deviceApproved") : t("deviceDenied")) : (r.error === "unknown_code" ? t("deviceUnknown") : r.error === "code_unusable" ? t("deviceUnusable") : r.error === "csrf" ? t("stale") : t("opFailed"));
      if (r.ok && r.redirectUrl) {
        try {
          const target = new URL(r.redirectUrl);
          if (target.protocol === "http:" && target.hostname === "127.0.0.1" && Number(target.port) >= 1024 && target.pathname === "/api/local/auth/callback" && !target.username && !target.password && !target.hash) location.assign(target.href);
        } catch {}
      }
    };
    $("#device-approve").onclick = busy($("#device-approve"), () => post("/api/device/approve"));
    $("#device-deny").onclick = busy($("#device-deny"), () => post("/api/device/deny"));
  }
  function applyI18n() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach((n) => (n.textContent = t(n.dataset.i18n)));
    document.querySelectorAll("[data-i18n-html]").forEach((n) => (n.innerHTML = t(n.dataset.i18nHtml)));
    document.querySelectorAll(".lang-seg button").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
  }
  document.querySelectorAll(".lang-seg").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    try { localStorage.setItem("lang", b.dataset.lang); } catch {}
    location.reload();
  }));

  /* ---------- 登录弹窗 ---------- */
  function renderLoginForms(intent) {
    const box = $("#login-buttons"); if (!box) return;
    const focused = document.activeElement?.dataset?.provider;
    box.replaceChildren();
    if (S.status === "loading") return box.append(el("p", { className: "muted", textContent: t("loadingProviders") }));
    if (S.status === "failed") { const b = el("button", { className: "button", type: "button", textContent: t("retryLoad") }); b.addEventListener("click", bootstrap); return box.append(b); }
    const p = S.providers;
    const form = (provider, label) => {
      const f = el("form", { method: "post", action: "/api/auth/start" }, hidden("_csrf", S.csrf), hidden("provider", provider), hidden("intent", intent), hidden("return_to", S.returnTo),
        el("button", { className: "button button-provider", type: "submit", textContent: label }));
      f.lastChild.dataset.provider = provider; return f;
    };
    let any = false;
    if (p?.wechat?.available) { any = true; box.append(form("wechat", p.wechat.mode === "mp" ? t("loginWechat") : t("loginWechatQr"))); if (p.wechat.hint) box.append(el("p", { className: "fine", textContent: p.wechat.hint })); }
    if (p?.google?.available) { any = true; box.append(form("google", t("loginGoogle"))); if (p.google.hint) box.append(el("p", { className: "fine", textContent: p.google.hint })); }
    if (p?.dev?.available) { any = true; box.append(form("dev", t("loginDev"))); }
    if (!any) box.append(el("p", { className: "muted", textContent: t("noProviders") }));
    (box.querySelector(`[data-provider="${focused}"]`) || (dialog.open ? box.querySelector("button") : null))?.focus();
  }
  function openLogin({ intent = "login", returnTo } = {}) {
    if (!dialog || typeof dialog.showModal !== "function") return location.assign(`/login?return_to=${encodeURIComponent(returnTo || S.returnTo)}`);
    if (returnTo) S.returnTo = returnTo;
    dialog.dataset.intent = intent;
    $("#login-eyebrow").textContent = intent === "switch" ? t("switchAccount") : t("welcome");
    $("#login-title").textContent = intent === "switch" ? t("switchTitle") : t("loginTitle");
    const desc = $("#login-desc"); if (desc) desc.textContent = intent === "switch" ? t("switchDesc") : t("loginDesc");
    lastFocus = document.activeElement;
    renderLoginForms(intent);
    dialog.showModal();
    (dialog.querySelector(".button-provider") || dialog.querySelector(".modal-close"))?.focus();
  }
  dialog?.addEventListener("close", () => { if (lastFocus?.isConnected) lastFocus.focus(); });
  dialog?.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog?.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dialog.close()));

  /* ---------- 顶栏 ---------- */
  const isMember = () => !!S.user?.access?.member;
  function renderNav() {
    const box = $("#nav-auth"); if (!box) return;
    box.replaceChildren();
    if (S.status === "loading") return;
    if (S.status === "failed") { const b = el("button", { className: "button small", type: "button", textContent: t("retry") }); b.addEventListener("click", bootstrap); return box.append(b); }
    if (!S.user) {
      const b = el("button", { className: "button small", type: "button", textContent: t("login") }); b.addEventListener("click", () => openLogin());
      return box.append(b);
    }
    if (S.user.avatar && /^https:\/\//.test(S.user.avatar)) { const img = el("img", { className: "avatar", src: S.user.avatar, alt: "", referrerPolicy: "no-referrer" }); img.addEventListener("error", () => img.remove()); box.append(img); }
    box.append(el("span", { className: "user-name", textContent: S.user.name || t("user") }));
    box.append(el("span", { className: "badge" + (isMember() ? "" : " soft"), textContent: isMember() ? t("memberBadge") : S.user.access.beta ? t("betaBadge") : t("trialBadge")(S.user.access.trial.daysLeft, S.user.access.trial.usesLeft) }));
    if (S.webWorkspace && !/^\/app/.test(location.pathname)) box.append(el("a", { className: "button small button-primary", href: "/app", textContent: t("openApp") }));
    else if (location.pathname === "/") box.append(el("a", { className: "button small button-primary", href: "#download", textContent: t("downloadNav") }));
    if (!/^\/account/.test(location.pathname)) box.append(el("a", { className: "text-link", href: "/account", textContent: t("account") }));
    const out = el("button", { className: "text-link", type: "button", textContent: t("logout") });
    out.addEventListener("click", busy(out, async () => {
      const r = await postJson("/auth/logout");
      if (!r.ok) return toast(r.error === "csrf" ? t("stale") : t("logoutFailed"));
      toast(t("loggedOut"));
      if (/^\/(app|account)/.test(location.pathname)) return location.assign("/");
      await bootstrap();
    }));
    box.append(out);
  }

  /* ---------- 首页 CTA 与定价 ---------- */
  $("#hero-cta")?.addEventListener("click", () => { const d = $("#download"); d ? d.scrollIntoView({ behavior: "smooth" }) : location.assign("/#download"); });
  /* ---------- 下载区 ---------- */
  async function renderDownloads() {
    const box = $("#downloads"); if (!box) return;
    let d = null; try { d = await (await fetch("/api/download/latest")).json(); } catch {}
    const mb = (n) => (n / 1048576).toFixed(0) + " MB";
    const card = (title, sub, items, soon, note) => {
      const c = el("div", { className: "plan" + (items.some(Boolean) ? " featured" : "") }, el("h3", { textContent: title }), el("p", { className: "muted", textContent: sub }));
      let any = false;
      for (const [label, item] of items) {
        if (!item) continue; any = true;
        c.append(el("a", { className: "button button-primary", href: item.url, textContent: `${t("downloadBtn")(item.version)}${label ? " · " + label : ""}` }), el("p", { className: "fine", textContent: `${item.file} · ${mb(item.size)}` }));
      }
      if (!any) c.append(el("span", { className: "badge soft", textContent: soon }));
      // 未经 Apple 公证的应用在 macOS 上会被门禁报「已损坏」：安装后清掉隔离属性即可打开
      if (any && note) c.append(el("p", { className: "fine" }, note.text, " ", el("code", { textContent: note.command })));
      return c;
    };
    box.replaceChildren(card(t("dlMac"), t("dlMacSub"), [[t("dlApple"), d?.macArm], [t("dlIntel"), d?.macIntel]], t("dlSoon"), { text: t("dlMacGatekeeper"), command: "xattr -cr /Applications/PeerGrading.app" }), card(t("dlWin"), t("dlWinSub"), [["", d?.win]], t("dlSoon")));
  }
  renderDownloads();
  const planName = (pl) => { const k = "plan_" + pl.code; const v = (L[lang] || {})[k] ?? (L.zh || {})[k]; return v ?? pl.name; };
  const planPeriod = (pl) => (pl.mode === "permanent" ? t("lifetime") : t("perDays")(pl.days));
  const planDesc = (pl) => { const k = "planDesc_" + pl.code; const v = t(k); return v === k ? "" : typeof v === "function" ? v(pl.limit) : v; };
  function accessLine(a) {
    if (a.beta) return t("betaStatus") + (a.member ? " " + memberText() : "");
    if (a.member) return memberText();
    if (a.trial.active) return t("trialLeft")(a.trial.daysLeft, a.trial.usesLeft);
    return t(a.reason === "trial_expired" ? "trialExpired" : "trialExhausted");
  }
  /** 方案卡片：首页定价区与账号页共用。内测期间按钮禁用并标「内测结束后开放」 */
  function renderPlanCards(host) {
    const p = S.plan; if (!host || !p?.plans) return;
    host.replaceChildren();
    const a = S.user?.access;
    for (const pl of p.plans) {
      const card = el("div", { className: "plan" + (pl.limit != null ? " featured" : "") },
        el("h3", { textContent: planName(pl) }),
        el("div", { className: "price" }, fmtMoney(pl.priceCents, pl.currency), el("small", { textContent: planPeriod(pl) })));
      const d = planDesc(pl); if (d) card.append(el("p", { className: "muted", textContent: d }));
      if (pl.limit != null) card.append(el("span", { className: "badge" + (pl.left > 0 ? "" : " soft"), textContent: pl.left > 0 ? t("slotsLeft")(pl.left) : t("soldOut") }));
      const btn = el("button", { className: "button button-primary", type: "button" });
      if (p.beta) { btn.textContent = t("openAfterBeta"); btn.disabled = true; }
      else if (pl.limit != null && !(pl.left > 0)) { btn.textContent = t("soldOut"); btn.disabled = true; }
      else if (S.status !== "authenticated") { btn.textContent = t("loginToBuy"); btn.onclick = () => openLogin({ returnTo: "/account#pricing" }); }
      else if (a?.permanent) { btn.textContent = t("alreadyMember"); btn.disabled = true; }
      else { btn.textContent = a?.member && pl.mode === "days" ? t("renew") : t("buyNow"); btn.addEventListener("click", busy(btn, () => startPurchase(pl.code))); }
      card.append(btn); host.append(card);
    }
  }
  function renderPricing() {
    const p = S.plan; if (!p) return;
    const put = (id, v) => { const n = $(id); if (n) { n.textContent = v; n.hidden = !v; } };
    put("#pricing-title", p.beta ? t("pricingTitleBeta") : t("pricingTitle"));
    put("#trial-title", p.beta ? t("betaTitle") : t("trialTitle")); put("#trial-desc", p.beta ? t("betaDesc") : t("trialDesc")(p.trialDays, p.trialUses));
    put("#plans-title", p.beta ? t("afterBetaPlans") : "");
    renderPlanCards($("#plans"));
    const box = $("#membership-status"); if (!box) return;
    box.replaceChildren(); box.className = "notice";
    if (S.status !== "authenticated") { box.append(el("span", { textContent: p.beta ? t("pricingAnonBeta") : t("pricingAnon")(p.trialDays, p.trialUses) })); return; }
    const a = S.user.access;
    if (a.member || a.beta) box.classList.add("ok"); else if (!a.trial.active) box.classList.add("warn");
    box.append(el("span", { textContent: accessLine(a) }));
  }
  function memberText() {
    const m = S.user.entitlements.find((e) => e.code === "member");
    if (!m?.active) return "";
    return m.permanentNow ? t("memberPermanent") : t("memberUntil")(fmtDate(m.continuousUntil));
  }
  async function startPurchase(planCode) {
    if (!S.user) return openLogin({ returnTo: "/account#pricing" });
    if (S.plan?.beta) return toast(t("betaFreeOrder"));
    const r = await postJson("/api/billing/orders", { plan: planCode || S.plan?.plans?.[0]?.code });
    if (!r.ok || !r.order) return toast(r.error === "csrf" ? t("stale") : r.error === "beta_free" ? t("betaFreeOrder") : r.error === "sold_out" ? t("soldOutOrder") : t("orderFailed"));
    renderOrder(r.order);
  }
  function renderOrder(o) {
    clearTimeout(paymentPoll);
    const host = $("#order-box") || $("#membership-status")?.parentElement; if (!host) return;
    let box = $("#order-panel"); if (!box) { box = el("div", { id: "order-panel", className: "order" }); host.append(box); }
    box.replaceChildren(
      el("div", { className: "eyebrow", textContent: t("orderCreated") }),
      el("div", {}, el("span", { className: "muted", textContent: t("orderNo") + " " }), el("span", { className: "no", textContent: o.no })),
      el("div", {}, el("span", { className: "muted", textContent: t("planLabel") + " " }), el("span", { textContent: (S.plan?.plans || []).filter((x) => x.code === o.plan).map(planName)[0] || o.plan || "" })),
      el("div", {}, el("span", { className: "muted", textContent: t("amount") + " " }), el("strong", { textContent: fmtMoney(o.amountCents, o.currency) })),
    );
    const checkoutBox = el("div", { className: "checkout-box" });
    const methods = el("div", { className: "ops" });
    const providers = o.paymentProviders || S.plan?.paymentProviders || [];
    for (const provider of providers.filter((p) => p.configured)) {
      const button = el("button", { className: "button small button-primary", type: "button", textContent: t(provider.id === "wechat" ? "payWechatOnline" : "payCardOnline"), disabled: !!o.checkoutProvider && o.checkoutProvider !== provider.id });
      button.addEventListener("click", busy(button, async () => {
        const r = await postJson(`/api/billing/orders/${encodeURIComponent(o.no)}/checkout`, { provider: provider.id });
        if (!r.ok || !r.checkout) return toast(paymentError(r.error));
        for (const other of methods.querySelectorAll("button")) if (other !== button) other.disabled = true;
        const c = r.checkout;
        if (c.kind === "qr") {
          checkoutBox.replaceChildren(el("p", { textContent: t("scanWechatPay") }));
          if (typeof c.qrDataUrl !== "string" || !c.qrDataUrl.startsWith("data:image/png;base64,")) return toast(t("paymentFailed"));
          checkoutBox.append(el("img", { src: c.qrDataUrl, alt: t("payQr"), width: 280, height: 280 }), el("p", { className: "fine", textContent: t("paymentWaiting") }));
          pollOrder(o.no, c.expiresAt);
        } else if (c.kind === "airwallex") {
          try { await loadCardSdk(); await window.PeerGradingCards.checkout(c, lang); }
          catch { toast(t("paymentFailed")); }
        }
      }));
      methods.append(button);
    }
    if (methods.childElementCount) box.append(methods, checkoutBox);
    if (o.qrUrl) box.append(el("img", { src: o.qrUrl, alt: t("payQr") }));
    box.append(el("p", { className: "muted", textContent: o.instructions || (methods.childElementCount ? t("paymentChoose") : t("payInstructionsDefault")) }));
    const row = el("div", { className: "ops" });
    if (o.mockPay) { const b = el("button", { className: "button small button-primary", type: "button", textContent: t("mockPay") }); b.addEventListener("click", busy(b, async () => { const r = await postJson("/api/dev/pay", { no: o.no }); if (!r.ok) return toast(t("orderFailed")); toast(t("paid")); await bootstrap(); })); row.append(b); }
    const chk = el("button", { className: "text-link", type: "button", textContent: t("checkPaid") });
    chk.addEventListener("click", busy(chk, async () => {
      const r = await postJson(`/api/billing/orders/${encodeURIComponent(o.no)}/sync`);
      if (r?.order?.status === "paid") { toast(t("paid")); await bootstrap(); } else toast(t("notPaidYet"));
    }));
    row.append(chk); box.append(row);
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function paymentError(error) {
    if (error === "checkout_provider_locked") return t("paymentProviderLocked");
    if (error === "payment_not_configured") return t("paymentUnavailable");
    if (error === "csrf") return t("stale");
    return t("paymentFailed");
  }
  function loadCardSdk() {
    if (window.PeerGradingCards) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = el("script", { src: "/payment-sdk.js" });
      script.onload = () => window.PeerGradingCards ? resolve() : reject(new Error("SDK unavailable"));
      script.onerror = () => { script.remove(); reject(new Error("SDK unavailable")); }; document.head.append(script);
    });
  }
  async function pollOrder(no, expiresAt, attempt = 0) {
    clearTimeout(paymentPoll); pollingOrder = { no, expiresAt, attempt };
    const host = $("#order-panel");
    if (!host || document.hidden || attempt >= 120 || (expiresAt && Date.now() >= expiresAt * 1000)) return;
    const r = await fetch(`/api/billing/orders/${encodeURIComponent(no)}`).then((r) => r.ok ? r.json() : null).catch(() => null);
    if (r?.order?.status === "paid") { toast(t("paid")); return bootstrap(); }
    paymentPoll = setTimeout(() => pollOrder(no, expiresAt, attempt + 1), 5000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && pollingOrder) pollOrder(pollingOrder.no, pollingOrder.expiresAt, pollingOrder.attempt); });
  async function checkPaymentReturn() {
    const no = new URLSearchParams(location.search).get("order");
    if (location.pathname !== "/account" || !S.user || !no || !/^[A-Za-z0-9]{8,64}$/.test(no)) return;
    const r = await postJson(`/api/billing/orders/${encodeURIComponent(no)}/sync`);
    // The redirect only asks the server to query the gateway; it never grants membership.
    if (r.ok && r.order?.status === "paid") { toast(t("paid")); history.replaceState(null, "", "/account"); await bootstrap(); }
    else if (r.order) { renderOrder(r.order); toast(t("paymentWaiting")); pollOrder(no, null); }
  }

  /* ---------- 账号页 ---------- */
  function renderAccount() {
    const root = $("#account-root"); if (!root) return;
    root.replaceChildren();
    if (S.status === "loading") return root.append(el("p", { className: "muted", textContent: t("loading") }));
    if (S.status === "failed") { const b = el("button", { className: "button", type: "button", textContent: t("retryLoad") }); b.addEventListener("click", bootstrap); return root.append(b); }
    if (!S.user) { root.append(el("p", { className: "muted", textContent: t("pleaseLogin") })); return openLogin({ returnTo: "/account" }); }
    const a = S.user.access;
    // 使用权
    const kv = el("dl", { className: "kv" });
    const row = (k, v) => kv.append(el("dt", { textContent: k }), el("dd", { textContent: v }));
    row(t("statusLabel"), accessLine(a));
    row(t("daysLeftLabel"), a.daysLeft == null ? t("permanentLabel") : a.beta && !a.member ? t("betaUnlimited") : t("daysUnit")(a.daysLeft));
    row(t("usedLabel"), String(a.trial.used));
    row(t("sinceLabel"), fmtDate(S.user.createdAt));
    row(t("userIdLabel"), String(S.user.id));
    root.append(el("h3", { textContent: t("accessTitle") }), kv);
    if (!a.permanent) { const plans = el("div", { className: "plans" }); renderPlanCards(plans); root.append(el("h3", { textContent: S.plan?.beta ? t("afterBetaPlans") : t("plansTitle") }), plans, el("div", { id: "order-box" })); }
    renderReferral(root);
    renderWechatGroup(root);
    // 订单
    fetch("/api/billing/status").then((r) => r.json()).then((d) => {
      if (!d.orders?.length) return;
      const nameOf = (code) => (S.plan?.plans || []).filter((x) => x.code === code).map(planName)[0] || code || "";
      const tbl = el("table", { className: "orders" }, el("thead", {}, el("tr", {}, el("th", { textContent: t("orderNo") }), el("th", { textContent: t("planLabel") }), el("th", { textContent: t("amount") }), el("th", { textContent: t("statusLabel") }), el("th", { textContent: t("timeLabel") }))));
      const tb = el("tbody");
      for (const o of d.orders) tb.append(el("tr", {}, el("td", { textContent: o.merchant_order_no }), el("td", { textContent: nameOf(o.plan_code) }), el("td", { textContent: fmtMoney(o.amount_cents, o.currency) }), el("td", { textContent: t("os_" + o.status) }), el("td", { textContent: fmtDate(o.created_at) })));
      tbl.append(tb); root.append(el("h3", { textContent: t("ordersTitle") }), tbl);
      const pending = d.orders.find((o) => o.status === "pending");
      if (pending && !a.permanent && !S.plan?.beta) { const b = el("button", { className: "text-link", type: "button", textContent: t("continuePay") }); b.addEventListener("click", () => startPurchase(pending.plan_code)); root.append(b); }
    }).catch(() => {});
    // 身份
    const names = { google: "Google", wechat: t("wechat"), dev: t("devAccount") }, chan = { mp: t("chanMp"), open: t("chanQr") };
    const ids = S.user.identities, providersHeld = new Set(ids.map((i) => i.provider));
    const canRemove = ids.length > 1;
    const needVerify = () => toast(t("needVerify"), 6000);
    const list = el("ul", { className: "id-list" });
    // 微信：扫码与公众号两个身份显示为一组，整组解绑；重新验证只能在对应渠道里做
    const wx = ids.filter((i) => i.provider === "wechat");
    if (wx.length) {
      const li = el("li", {}, el("span", { textContent: `${t("wechat")} · ${wx.map((i) => `${chan[i.channel] || ""}${i.display_name ? " " + i.display_name : ""}`).join(" / ")}` }));
      const ops = el("div", { className: "ops" });
      for (const i of wx) { const ok = !!S.providers?.wechat?.available && S.providers.wechat.mode === (i.channel === "mp" ? "mp" : "qr"); const b = el("button", { className: "text-link", type: "button", textContent: `${t("reverify")}（${chan[i.channel] || ""}）`, disabled: !ok }); b.addEventListener("click", busy(b, () => reverify(i.id))); ops.append(b); }
      if (canRemove && ids.length > wx.length) { const b = el("button", { className: "text-link", type: "button", textContent: t("unbindWechat") }); b.addEventListener("click", busy(b, () => unbind({ provider: "wechat" }, t("confirmUnbindWechat")))); ops.append(b); }
      li.append(ops); list.append(li);
    }
    for (const i of ids.filter((i) => i.provider !== "wechat")) {
      const li = el("li", {}, el("span", { textContent: `${names[i.provider] || i.provider}${i.display_name ? " · " + i.display_name : ""}` }));
      const ops = el("div", { className: "ops" });
      const rv = el("button", { className: "text-link", type: "button", textContent: t("reverify"), disabled: !S.providers?.[i.provider]?.available }); rv.addEventListener("click", busy(rv, () => reverify(i.id))); ops.append(rv);
      if (canRemove) { const b = el("button", { className: "text-link", type: "button", textContent: t("unbind") }); b.addEventListener("click", busy(b, () => unbind({ identityId: i.id }, t("confirmUnbind")))); ops.append(b); }
      li.append(ops); list.append(li);
    }
    root.append(el("h3", { textContent: t("identitiesTitle") }), list);
    const bindRow = el("div", { className: "bind-row" });
    for (const p of ["wechat", "google", "dev"]) {
      if (!S.providers?.[p]?.available) continue;
      if (p !== "wechat" && providersHeld.has(p)) continue;
      if (p === "wechat" && wx.some((i) => i.channel === (S.providers.wechat.mode === "mp" ? "mp" : "open"))) continue;   // 当前渠道的微信身份已关联
      const b = el("button", { className: "button small", type: "button", textContent: t("bind") + names[p] });
      b.addEventListener("click", busy(b, async () => {
        if (!S.user.recentlyVerified) return needVerify();
        const r = await postJson("/api/account/bind", { provider: p });
        if (r.ok && r.url) return location.assign(r.url);
        toast(r.error === "reverify_required" ? t("needVerifyShort") : r.error === "csrf" ? t("stale") : t("bindFailed"));
      }));
      bindRow.append(b);
    }
    if (bindRow.children.length) root.append(el("h3", { textContent: t("bindMore") }), bindRow);
    root.append(el("p", { className: "fine", textContent: S.user.recentlyVerified ? t("verifiedRecently") : t("verifyHint") }));
    fetch("/api/device/list").then((r) => r.json()).then((d) => {
      if (!d.devices?.length) return;
      const list = el("ul", { className: "id-list" });
      for (const dv of d.devices) {
        const li = el("li", {}, el("span", { textContent: `${dv.deviceName || t("deviceUnnamed")} · ${t("deviceSince")} ${fmtDate(dv.createdAt)}${dv.lastSeenAt ? " · " + t("deviceSeen") + " " + fmtDate(dv.lastSeenAt) : ""}` }));
        const b = el("button", { className: "text-link", type: "button", textContent: t("deviceRevoke") });
        b.addEventListener("click", busy(b, async () => { if (!confirm(t("deviceRevokeConfirm"))) return; const r = await postJson("/api/device/revoke", { id: dv.id }); toast(r.ok ? t("deviceRevoked") : t("opFailed")); if (r.ok) li.remove(); }));
        li.append(el("div", { className: "ops" }, b)); list.append(li);
      }
      root.append(el("h3", { textContent: t("devicesTitle") }), list);
    }).catch(() => {});
    const sw = el("button", { className: "text-link", type: "button", textContent: t("switchOther") });
    sw.addEventListener("click", () => openLogin({ intent: "switch", returnTo: "/account" })); root.append(el("h3", { textContent: t("other") }), sw);

    /* ---------- 邀请好友 ---------- */
    function renderReferral(root) {
      const sec = el("div", { className: "referral" });
      root.append(el("h3", { textContent: t("referralTitle") }), sec);
      fetch("/api/referral").then((r) => r.json()).then((d) => {
        const r = d.referral; if (!r) return;
        sec.append(el("p", { className: "muted", textContent: t("referralDesc")(r.days) }));
        const copyBtn = (text) => { const b = el("button", { className: "text-link", type: "button", textContent: t("copy") }); b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); toast(t("copied")); } catch { prompt(t("copy"), text); } }); return b; };
        const kv2 = el("dl", { className: "kv" });
        kv2.append(el("dt", { textContent: t("referralCodeLabel") }), el("dd", {}, el("span", { className: "no", textContent: r.code }), " ", copyBtn(r.code)));
        kv2.append(el("dt", { textContent: t("referralLinkLabel") }), el("dd", {}, el("span", { className: "no", textContent: r.link }), " ", copyBtn(r.link)));
        sec.append(kv2, el("p", { className: "muted", textContent: t("referralStats")(r.invited, r.earnedDays) + (r.pendingDays > 0 ? " " + t("referralPending")(r.pendingDays) : "") }));
        if (r.claimed) sec.append(el("p", { className: "muted", textContent: t("referralClaimed")(r.claimed.days) }));
        else if (r.canClaim) {
          const input = el("input", { placeholder: t("referralClaimPlaceholder"), maxLength: 12, autocomplete: "off", spellcheck: false });
          const b = el("button", { className: "button small", type: "button", textContent: t("referralClaimBtn") });
          b.addEventListener("click", busy(b, async () => {
            const x = await postJson("/api/referral/claim", { code: input.value });
            if (!x.ok) return toast(t("referralErrors")[x.error] || t("opFailed"));
            toast(t("referralClaimed")(x.days)); await bootstrap();
          }));
          sec.append(el("h4", { textContent: t("referralClaimTitle") }), el("div", { className: "ops" }, input, b), el("p", { className: "fine", textContent: t("referralClaimHint")(S.plan?.referralClaimDays ?? 7) }));
        }
      }).catch(() => {});
    }
    /* ---------- 内测微信群 ---------- */
    function renderWechatGroup(root) {
      const g = S.user?.wechatGroup; if (!g || (!g.qrUrl && !g.note)) return;
      const sec = el("div", { className: "wechat-group" });
      if (g.qrUrl) sec.append(el("img", { src: g.qrUrl, alt: t("wechatGroupTitle") }));
      sec.append(el("p", { className: "muted", textContent: g.note || t("wechatGroupDesc") }));
      root.append(el("h3", { textContent: t("wechatGroupTitle") }), sec);
    }
    async function reverify(identityId) {
      const r = await postJson("/api/account/reverify", { identityId });
      if (r.ok && r.url) return location.assign(r.url);
      toast(r.error === "channel_unavailable" ? t("channelUnavailable") : t("verifyFailed"));
    }
    async function unbind(sel, confirmText) {
      if (!S.user.recentlyVerified) return needVerify();
      if (!confirm(confirmText)) return;
      const r = await postJson("/api/account/unbind", sel);
      if (r.ok) { toast(t("unbound")); return bootstrap(); }
      toast({ last_identity: t("lastIdentity"), reverify_required: t("needVerifyShort"), csrf: t("stale"), network: t("network") }[r.error] || t("opFailed"));
    }
  }

  /* ---------- URL 提示 ---------- */
  function handleQuery() {
    const q = new URLSearchParams(location.search);
    const login = q.get("login"), op = q.get("op");
    const Lm = t("loginMsgs"), Om = t("opMsgs");
    if (login && Lm[login]) toast(Lm[login], 6000);
    if (op && Om[op]) toast(Om[op], 7000);
    if (login === "required" || (login === "stale" && S.status === "anonymous")) openLogin();
    if (login || op) history.replaceState(null, "", location.pathname + location.hash);
    if (location.hash === "#pricing" && $("#account-root")) $("#order-box")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  window.SiteAuth = { openLogin, bootstrap, state: S, t };
  const y = $("#year"); if (y) y.textContent = String(new Date().getFullYear());
  bootstrap().then(() => { handleQuery(); return checkPaymentReturn(); });
})();
