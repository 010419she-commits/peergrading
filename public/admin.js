/* admin.js — 站主后台：内测开关 / 收款设置 / 早鸟与邀请 / 微信群 / 订单确认 / 用户剩余天数（中文） */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, p = {}, ...k) => { const n = document.createElement(t); Object.assign(n, p); n.append(...k); return n; };
  const S = window.SiteAuth?.state || {};
  const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }) : "—");
  const fmtDay = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString("zh-CN") : "—");
  const money = (c, cur) => (cur === "CNY" ? "¥" : cur + " ") + (c / 100).toFixed(2).replace(/\.00$/, "");
  const toastEl = $("#toast");
  const toast = (m, ms = 4000) => { if (!toastEl) return alert(m); toastEl.textContent = m; toastEl.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (toastEl.hidden = true), ms); };
  const busy = (btn, fn) => async () => { if (btn.disabled) return; btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
  async function api(url, opts = {}) {
    try {
      const r = await fetch(url, { ...opts, headers: { accept: "application/json", "x-csrf-token": S.csrf || "", ...(opts.headers || {}) } });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, ...d };
    } catch { return { ok: false, status: 0, error: "network" }; }
  }
  const post = (url, body) => api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const ERR = { csrf: "页面状态已过期，请刷新后重试", network: "网络错误，请重试", unsupported_type: "只支持 PNG / JPG / WebP 图片", empty: "文件为空", order_not_pending: "该订单不是待支付状态", amount_mismatch: "金额不一致", unknown_order: "订单不存在", bad_days: "天数不正确", sold_out: "早鸟名额已满，未发放会员：请退款，或在用户列表里手动赠送" };
  const errText = (e) => ERR[e] || (e ? `操作失败（${e}）` : "操作失败");
  const PLAN_NAMES = { earlybird: "早鸟终身版", monthly: "月付" };
  const planName = (c) => PLAN_NAMES[c] || c;

  let D = null;
  const root = $("#admin-root");
  async function load() {
    if (!S.csrf) await window.SiteAuth?.bootstrap?.();
    const r = await api("/api/admin/overview");
    if (r.status === 401) { root.replaceChildren(el("p", { className: "muted", textContent: "请先登录。" })); return window.SiteAuth?.openLogin({ returnTo: "/admin" }); }
    if (!r.ok) { root.replaceChildren(el("p", { className: "muted", textContent: "当前账号不是管理员。在服务器的 .env 里设置 ADMIN_USER_IDS=<你的用户 ID>（账号页可查看），或执行 npm run grant -- <用户ID> admin permanent，然后刷新。" })); return; }
    D = r; render();
  }

  function render() {
    root.replaceChildren();
    const s = D.settings, st = D.stats, eb = D.earlyBird;
    /* 概况 */
    root.append(el("div", { className: "stats" },
      el("span", {}, "用户 ", el("b", { textContent: st.users })), el("span", {}, "会员 ", el("b", { textContent: st.members })), el("span", {}, "试用中 ", el("b", { textContent: st.trialActive })),
      el("span", {}, "待确认订单 ", el("b", { textContent: st.pendingOrders })), el("span", {}, "邀请 ", el("b", { textContent: st.referrals }), st.pendingReferrals ? `（${st.pendingReferrals} 条待发放）` : ""),
      el("span", {}, "早鸟已售 ", el("b", { textContent: `${eb.sold} / ${eb.limit}` }))));

    /* 内测开关 */
    const betaBox = el("div", { className: "card" });
    const betaChk = el("input", { type: "checkbox", checked: s.betaFree });
    betaBox.append(el("label", { className: "inline" }, betaChk, "内测免费：所有登录用户免费使用，不显示购买入口，桌面软件不弹付费提示"),
      el("p", { className: "fine", textContent: s.betaFree
        ? "关闭后：按会员 / 试用规则放行，试用结束或会员到期即停止使用；内测期间注册的用户从关闭那一刻起重新计算 3 天 / 5 次试用；已登记但未发放的邀请奖励立即发放。"
        : `内测已于 ${fmtDate(s.betaEndedAt)} 关闭。重新开启后所有用户再次免费。` }));
    const betaBtn = el("button", { className: "button small button-primary", type: "button", textContent: "保存开关" });
    betaBtn.addEventListener("click", busy(betaBtn, async () => {
      if (betaChk.checked === s.betaFree) return toast("没有改动");
      if (!betaChk.checked && !confirm("确定关闭内测免费？关闭后试用结束 / 会员到期的用户将无法继续使用。")) { betaChk.checked = true; return; }
      const r = await post("/api/admin/settings", { betaFree: betaChk.checked });
      if (!r.ok) return toast(errText(r.error));
      toast(betaChk.checked ? "已开启内测免费" : `已关闭内测免费，发放了 ${r.settledReferrals} 条邀请奖励`); await load();
    }));
    betaBox.append(el("div", { className: "ops" }, betaBtn));
    root.append(el("h3", { textContent: "内测开关" }), betaBox);

    /* 收款设置 */
    const payBox = el("div", { className: "card" });
    const payText = el("textarea", { value: s.payInstructions || "", placeholder: "例如：微信扫码付款，付款时备注订单号；确认到账后会员立即生效。" });
    payBox.append(el("label", {}, "付款说明（下单后显示给用户）", payText));
    payBox.append(uploadRow("收款码图片（微信 / 支付宝收款码）", "pay_qr", s.payQrUrl));
    const paySave = el("button", { className: "button small button-primary", type: "button", textContent: "保存付款说明" });
    paySave.addEventListener("click", busy(paySave, async () => { const r = await post("/api/admin/settings", { payInstructions: payText.value }); toast(r.ok ? "已保存" : errText(r.error)); if (r.ok) await load(); }));
    payBox.append(el("div", { className: "ops" }, paySave), el("p", { className: "fine", textContent: "用户付款后，在下面的「订单」里点「确认到账」，会员即刻生效。个人收款不走支付回调，无需接入支付平台。" }));
    root.append(el("h3", { textContent: "收款设置" }), payBox);

    /* 早鸟与邀请 */
    const ebBox = el("div", { className: "card" });
    const ebLimit = el("input", { type: "number", min: 0, step: 1, value: s.earlyBirdLimit });
    const ebPrice = el("input", { type: "number", min: 0.01, step: 0.01, value: (s.earlyBirdPriceCents / 100).toFixed(2) });
    const refDays = el("input", { type: "number", min: 0, step: 1, value: s.referralDays });
    ebBox.append(el("div", { className: "grid2" },
      el("label", {}, "早鸟终身版名额（前 N 名）", ebLimit),
      el("label", {}, "早鸟价格（元）", ebPrice),
      el("label", {}, "邀请奖励天数（邀请者与被邀请者各得）", refDays)));
    ebBox.append(el("p", { className: "fine", textContent: `早鸟已售 ${eb.sold}，待支付占用 ${eb.reserved}，剩余 ${eb.left}。待支付订单 24 小时内占用名额。邀请奖励：每人最多因邀请获奖 ${s.referralMax ?? "20"} 次（.env REFERRAL_MAX 可改），被邀请者注册后一周内可填码。` }));
    const ebSave = el("button", { className: "button small button-primary", type: "button", textContent: "保存" });
    ebSave.addEventListener("click", busy(ebSave, async () => {
      // 留空的字段不提交（否则 Number("") === 0 会把名额或奖励天数改成 0）
      const num = (inp, scale = 1) => (inp.value.trim() === "" ? undefined : Math.round(Number(inp.value) * scale));
      const r = await post("/api/admin/settings", { earlyBirdLimit: num(ebLimit), earlyBirdPriceCents: num(ebPrice, 100), referralDays: num(refDays) });
      toast(r.ok ? "已保存" : errText(r.error)); if (r.ok) await load();
    }));
    ebBox.append(el("div", { className: "ops" }, ebSave));
    root.append(el("h3", { textContent: "早鸟与邀请" }), ebBox);

    /* 微信群 */
    const wxBox = el("div", { className: "card" });
    wxBox.append(uploadRow("内测微信群二维码（显示在用户的账号页）", "wechat_group", s.wechatGroupQrUrl));
    const wxNote = el("textarea", { value: s.wechatGroupNote || "", placeholder: "例如：扫码加入内测群，反馈问题、获取更新通知。群二维码过期后请重新上传。" });
    wxBox.append(el("label", {}, "说明文字", wxNote));
    const wxSave = el("button", { className: "button small button-primary", type: "button", textContent: "保存说明" });
    wxSave.addEventListener("click", busy(wxSave, async () => { const r = await post("/api/admin/settings", { wechatGroupNote: wxNote.value }); toast(r.ok ? "已保存" : errText(r.error)); if (r.ok) await load(); }));
    wxBox.append(el("div", { className: "ops" }, wxSave));
    root.append(el("h3", { textContent: "微信群" }), wxBox);

    /* 订单 */
    const orders = D.orders || [];
    const oWrap = el("div", { className: "table-wrap" });
    const oTbl = el("table", {}, el("thead", {}, el("tr", {}, ...["订单号", "用户", "方案", "金额", "状态", "下单时间", "操作"].map((h) => el("th", { textContent: h })))));
    const oTb = el("tbody");
    for (const o of orders) {
      const tr = el("tr", {}, el("td", { textContent: o.no }), el("td", { textContent: `${o.userName || "—"} #${o.userId}` }), el("td", { textContent: planName(o.plan) }), el("td", { textContent: money(o.amountCents, o.currency) }),
        el("td", { textContent: { pending: "待支付", paid: "已支付", refunded: "已退款", partially_refunded: "部分退款", failed: "失败", closed: "已关闭" }[o.status] || o.status }), el("td", { textContent: fmtDate(o.createdAt) }));
      const ops = el("td");
      if (o.status === "pending") {
        const b = el("button", { className: "button mini button-primary", type: "button", textContent: "确认到账" });
        b.addEventListener("click", busy(b, async () => {
          if (!confirm(`确认已收到订单 ${o.no} 的 ${money(o.amountCents, o.currency)}？确认后立即发放权益。`)) return;
          const r = await post(`/api/admin/orders/${encodeURIComponent(o.no)}/confirm`, {});
          toast(r.ok ? "已确认，权益已发放" : errText(r.error)); if (r.ok) await load();
        }));
        ops.append(b);
      }
      tr.append(ops); oTb.append(tr);
    }
    oTbl.append(oTb); oWrap.append(oTbl);
    root.append(el("h3", { textContent: `订单（${orders.length}）` }), orders.length ? oWrap : el("p", { className: "muted", textContent: "还没有订单。" }));

    /* 用户 */
    const users = D.users || [];
    const filter = el("input", { type: "text", placeholder: "按名称 / ID 筛选", style: "max-width:20em" });
    const uWrap = el("div", { className: "table-wrap" });
    const uTbl = el("table", {}, el("thead", {}, el("tr", {}, ...["ID", "名称", "登录方式", "注册时间", "最近活跃", "已用次数", "状态", "剩余天数", "邀请", "赠送会员"].map((h) => el("th", { textContent: h })))));
    const uTb = el("tbody");
    const statusOf = (a) => a.member ? (a.permanent ? el("span", { className: "tag ok", textContent: "永久会员" }) : el("span", { className: "tag ok", textContent: `会员至 ${fmtDay(a.memberUntil)}` }))
      : a.trialActive ? el("span", { className: "tag", textContent: `试用中 · 剩 ${a.usesLeft} 次` })
      : el("span", { className: "tag warn", textContent: a.reason === "trial_exhausted" ? "试用次数用完" : "试用已结束" });
    const draw = () => {
      const f = filter.value.trim().toLowerCase();
      uTb.replaceChildren();
      for (const u of users) {
        if (f && !String(u.id).includes(f) && !(u.name || "").toLowerCase().includes(f)) continue;
        const a = u.access;
        const tr = el("tr", {}, el("td", { textContent: u.id }), el("td", { className: "wrap-cell" }, u.name || "—", u.admin ? el("span", { className: "tag", textContent: "管理员" }) : "", u.status !== "active" ? el("span", { className: "tag warn", textContent: "已停用" }) : ""),
          el("td", { textContent: u.providers.map((p) => ({ google: "Google", wechat: "微信", dev: "开发者" }[p] || p)).join(" / ") || "—" }),
          el("td", { textContent: fmtDate(u.createdAt) }), el("td", { textContent: fmtDate(u.lastActive) }), el("td", { textContent: u.runs }),
          el("td", {}, statusOf(a), D.settings.betaFree ? el("span", { className: "tag", textContent: "内测免费中" }) : ""),
          el("td", { textContent: a.daysLeft == null ? "永久" : `${a.daysLeft} 天` }), el("td", { textContent: u.invited }));
        const days = el("input", { className: "mini", type: "number", min: 1, step: 1, value: 30 });
        const give = el("button", { className: "button mini", type: "button", textContent: "赠送天数" });
        give.addEventListener("click", busy(give, async () => {
          const n = Number(days.value); if (!(n >= 1)) return toast("请输入天数");
          if (!confirm(`给用户 #${u.id}（${u.name || "未命名"}）赠送 ${n} 天会员？`)) return;
          const r = await post(`/api/admin/users/${u.id}/grant`, { period: "days", days: n }); toast(r.ok ? "已赠送" : errText(r.error)); if (r.ok) await load();
        }));
        const perm = el("button", { className: "button mini", type: "button", textContent: "永久" });
        perm.addEventListener("click", busy(perm, async () => {
          if (!confirm(`给用户 #${u.id}（${u.name || "未命名"}）赠送永久会员？`)) return;
          const r = await post(`/api/admin/users/${u.id}/grant`, { period: "permanent" }); toast(r.ok ? "已赠送" : errText(r.error)); if (r.ok) await load();
        }));
        tr.append(el("td", {}, el("div", { className: "ops", style: "gap:6px" }, days, give, perm)));
        uTb.append(tr);
      }
    };
    filter.addEventListener("input", draw); draw();
    uTbl.append(uTb); uWrap.append(uTbl);
    root.append(el("h3", { textContent: `用户（${users.length}）` }), filter, el("p", { className: "fine", textContent: "剩余天数：永久会员显示「永久」；会员按到期日计算；试用中按试用期末计算；内测免费期间所有用户都可使用，天数仅供参考。" }), uWrap);
  }

  function uploadRow(label, kind, url) {
    const box = el("div", {}, el("p", { className: "muted", textContent: label, style: "margin:0 0 8px;font-size:14px" }));
    if (url) box.append(el("img", { className: "preview", src: url, alt: label }));
    const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp" });
    const up = el("button", { className: "button mini", type: "button", textContent: "上传" });
    up.addEventListener("click", busy(up, async () => {
      const f = file.files?.[0]; if (!f) return toast("请先选择图片");
      if (f.size > 5 * 1024 * 1024) return toast("图片不能超过 5 MB");
      let r;
      try {
        const x = await fetch(`/api/admin/upload?kind=${kind}`, { method: "POST", headers: { "content-type": f.type || "application/octet-stream", "x-csrf-token": S.csrf || "", accept: "application/json" }, body: f });
        r = { ok: x.ok, ...(await x.json().catch(() => ({}))) };
      } catch { r = { ok: false, error: "network" }; }
      toast(r.ok ? "已上传" : errText(r.error)); if (r.ok) await load();
    }));
    const row = el("div", { className: "ops", style: "margin-top:8px" }, file, up);
    if (url) { const del = el("button", { className: "text-link", type: "button", textContent: "删除" }); del.addEventListener("click", busy(del, async () => { if (!confirm("删除这张图片？")) return; const r = await post("/api/admin/upload/clear", { kind }); toast(r.ok ? "已删除" : errText(r.error)); if (r.ok) await load(); })); row.append(del); }
    box.append(row);
    return box;
  }

  load();
})();
