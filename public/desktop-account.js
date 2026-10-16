(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const node = (tag, props = {}, ...children) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...children); return n; };
  const language = (() => { try { return localStorage.getItem("lang") || (navigator.language.startsWith("zh") ? "zh" : "en"); } catch { return "zh"; } })();
  const words = {
    zh: {
      brandSub:"双 Agent，一起把代码做好",workspace:"返回工作台",loading:"正在读取账号…",welcome:"让两位 Agent，接着你的仓库往下做。",intro:"选一个已有 Git 仓库，让两位 Agent 轮流改文件、审查差异并运行测试。每轮都有提交和补丁，结果由你审阅合并。",pickRepo:"选择仓库",editReview:"修改与审查",testCommit:"测试与提交",localNote:"代码与 Agent 在本机运行；账号与会员资格由服务端核验。",yourAccount:"你的 PeerGrading 账号",signInTitle:"登录，开始协作",signInDesc:"首次授权会自动创建账号。登录后，在软件里查看会员、订单和邀请奖励。",signIn:"登录 / 注册",browserNote:"第三方授权会在系统浏览器中完成，然后自动连接软件，无需手填配对码。",reopen:"重新打开授权页",cancel:"取消",pairFallback:"连接码与手动连接（备用）",pairHelp:"仅在授权页没有自动填写时使用此 8 位连接码。10 分钟内有效，使用一次后失效。",advanced:"高级：服务地址",save:"保存",terms:"服务条款",privacy:"隐私政策",accountTitle:"账号与会员",refresh:"刷新状态",signOut:"退出登录",membership:"会员方案",orders:"订单与付款",referralTitle:"邀请与奖励",security:"登录与设备",footer:"代码留在本机，协作过程可追溯。",wait:"等待浏览器授权，确认后将自动进入工作台…",expired:"登录请求已过期，请重新登录。",denied:"已取消授权，可以重新登录。",consumed:"连接码已使用，请重新发起登录。",failed:"操作暂未完成，请重试。",network:"无法连接账号服务，请检查网络后重试。",csrf:"页面校验已过期，请刷新后重试。",unauthenticated:"登录已失效，请重新登录。",beta_free:"免费内测期间无需购买会员。",sold_out:"此方案名额已售罄。",payment_not_configured:"收款渠道尚未配置。",checkout_provider_locked:"此订单已选择另一付款方式，请继续原付款流程。",self_referral:"不能填写自己的邀请码。",unknown_code:"邀请码不存在。",already_claimed:"已经领取过邀请奖励。",claim_window_closed:"填写邀请码的期限已结束。",trial:"试用",beta:"内测免费",permanent:"终身会员",member:"会员",accessEnded:"试用或会员已到期",betaNote:"免费内测中，无需付款即可使用。",afterBeta:"内测结束后开放购买",buy:"购买",renew:"续费",soldOut:"已售罄",hasMember:"已开通终身会员",oneTime:"一次购买",perMonth:"每 30 天",earlybird:"早鸟终身版",monthly:"月付会员",slots:"剩余名额",noPayment:"支付渠道待开通",noOrders:"还没有订单。",orderPending:"待付款",orderPaid:"已付款",orderClosed:"已关闭",viewOrder:"查看",checkPayment:"查询支付结果",waitingPayment:"尚未确认付款。若刚刚支付，请稍后再查。",paid:"付款已核验，会员状态已更新。",wechatPay:"微信扫码付款",cardPay:"Visa / Mastercard",scan:"使用微信扫描二维码完成支付。",cardOpened:"已在浏览器打开信用卡付款，完成后回到这里查询支付结果。",payUnavailable:"当前暂无可用的在线支付渠道。",copy:"复制邀请码",copied:"邀请码已复制",claim:"领取奖励",claimPlaceholder:"填写好友邀请码",referralLead:"邀请好友，双方获得会员奖励。",referralStats:"已邀请 / 奖励天数",pendingDays:"待内测结束发放",claimed:"已领取邀请奖励",deviceCurrent:"当前电脑",revoke:"断开",confirmRevoke:"确定断开这台设备的账号连接？",confirmSignOut:"退出登录会停止本机正在进行的协作。确定退出？",securityManage:"绑定或解绑登录方式",securityNote:"修改登录身份需要在浏览器重新验证。",user:"PeerGrading 用户",accountId:"用户 ID",created:"注册于",daysLeft:"剩余天数",runsLeft:"剩余试用次数",offline:"账号服务暂不可用，当前显示本机缓存。",loggedOut:"已退出登录。",close:"关闭付款面板",cloudSaved:"服务地址已保存。",invalidReturn:"服务返回的地址无效。"
    },
    en: {
      brandSub:"Two agents. Better code, together.",workspace:"Back to workspace",loading:"Loading your account…",welcome:"Two agents. One existing repository.",intro:"Choose a Git repository. Let two agents take turns editing files, reviewing diffs and running checks. Each round leaves a commit and patch for you to review and merge.",pickRepo:"Choose a repository",editReview:"Edit & review",testCommit:"Check & commit",localNote:"Your code and agents run locally. Account and membership are verified by the server.",yourAccount:"Your PeerGrading account",signInTitle:"Sign in and start working",signInDesc:"Your first authorization creates an account. Manage membership, orders and referral rewards in the app.",signIn:"Sign in / Register",browserNote:"Third-party authorization opens in your system browser, then connects the app automatically. No pairing code to type.",reopen:"Reopen authorization",cancel:"Cancel",pairFallback:"Connection code (fallback)",pairHelp:"Only use this 8-character code if the authorization page did not fill it in. Valid once, for 10 minutes.",advanced:"Advanced: account service",save:"Save",terms:"Terms",privacy:"Privacy",accountTitle:"Account & membership",refresh:"Refresh status",signOut:"Sign out",membership:"Membership plans",orders:"Orders & payments",referralTitle:"Invites & rewards",security:"Sign-in & devices",footer:"Your code stays local. Every round is traceable.",wait:"Waiting for browser authorization. The workspace will open automatically…",expired:"This sign-in request expired. Please try again.",denied:"Authorization was declined. You can sign in again.",consumed:"This code was already used. Start a new sign-in.",failed:"Could not complete the action. Please retry.",network:"Cannot reach the account service. Check your connection and retry.",csrf:"This page expired. Refresh and retry.",unauthenticated:"Your sign-in expired. Please sign in again.",beta_free:"No purchase is needed during the free beta.",sold_out:"This plan is sold out.",payment_not_configured:"Payments are not configured yet.",checkout_provider_locked:"This order already uses another payment method. Continue that checkout.",self_referral:"You cannot use your own referral code.",unknown_code:"Referral code not found.",already_claimed:"You already claimed a referral reward.",claim_window_closed:"The referral claim window has ended.",trial:"Trial",beta:"Free beta",permanent:"Lifetime member",member:"Member",accessEnded:"Trial or membership ended",betaNote:"Free beta: no payment required.",afterBeta:"Available after beta",buy:"Buy",renew:"Renew",soldOut:"Sold out",hasMember:"Lifetime membership active",oneTime:"One-time",perMonth:"Every 30 days",earlybird:"Early-bird lifetime",monthly:"Monthly membership",slots:"Places left",noPayment:"Payments coming later",noOrders:"No orders yet.",orderPending:"Pending",orderPaid:"Paid",orderClosed:"Closed",viewOrder:"View",checkPayment:"Check payment result",waitingPayment:"Payment is not confirmed yet. If you just paid, check again shortly.",paid:"Payment verified. Membership updated.",wechatPay:"Pay with WeChat",cardPay:"Visa / Mastercard",scan:"Scan the QR code with WeChat to pay.",cardOpened:"Card checkout opened in your browser. Return here to check the result.",payUnavailable:"No online payment method is currently available.",copy:"Copy invite code",copied:"Invite code copied",claim:"Claim reward",claimPlaceholder:"Friend's invite code",referralLead:"Invite a friend and both receive membership rewards.",referralStats:"Invited / reward days",pendingDays:"To be granted after beta",claimed:"Referral reward claimed",deviceCurrent:"This computer",revoke:"Disconnect",confirmRevoke:"Disconnect this device from your account?",confirmSignOut:"Signing out stops collaboration running on this computer. Continue?",securityManage:"Manage sign-in methods",securityNote:"Changing sign-in identities requires verification in your browser.",user:"PeerGrading user",accountId:"User ID",created:"Joined",daysLeft:"Days left",runsLeft:"Trial runs left",offline:"Account service unavailable. Showing the local cache.",loggedOut:"Signed out.",close:"Close checkout",cloudSaved:"Account service saved.",invalidReturn:"The service returned an invalid URL."
    }
  };
  const t = (key) => (words[language] || words.zh)[key] || key;
  let boot = {}, data = null, pending = null, loginTimer = null, paymentTimer = null, currentOrder = null, loadSequence = 0;
  const notice = (message, error = false) => { const n = $("#notice"); n.textContent = message || ""; n.hidden = !message; n.classList.toggle("error", error); };
  const errorText = (value) => words[language]?.[value] || words.zh[value] || (typeof value === "string" && /[\u3400-\u9fff]/.test(value) ? value.slice(0, 300) : t("failed"));
  const date = (seconds) => seconds ? new Date(seconds * 1000).toLocaleDateString(language === "zh" ? "zh-CN" : "en-US") : "—";
  const money = (cents, currency) => new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", { style:"currency",currency:currency || "CNY", maximumFractionDigits:2 }).format(cents / 100);
  const action = (text, fn, cls = "button small") => { const b = node("button", { type:"button",className:cls,textContent:text }); b.onclick = async () => { if (b.disabled) return; b.disabled = true; try { await fn(); } catch (e) { notice(errorText(e.message), true); } finally { b.disabled = false; } }; return b; };
  async function api(path, body) {
    const sequence = loadSequence;
    const response = await fetch(path, { headers:{accept:"application/json", ...(body === undefined ? {} : {"content-type":"application/json","x-csrf-token":boot.csrf})}, ...(body === undefined ? {} : {method:"POST",body:JSON.stringify(body)}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (sequence === loadSequence && (response.status === 401 || result.error === "account_changed")) {
        boot.user = null; boot.paired = false; showLogin();
        if (result.error === "account_changed") setTimeout(load, 0);
      }
      throw new Error(result.error || "network");
    }
    return result;
  }
  function cloudAddress(path) { return new URL(path, boot.cloudUrl || "https://peergrading.ai").href; }
  async function external(url) {
    const target = new URL(url), cloud = new URL(boot.cloudUrl || "https://peergrading.ai");
    if (target.origin !== cloud.origin || target.username || target.password || !["https:","http:"].includes(target.protocol)) throw new Error("invalidReturn");
    if (window.peergrading?.openExternal) await window.peergrading.openExternal(target.href);
    else window.open(target.href, "_blank", "noopener,noreferrer");
  }
  async function workspace() { if (window.peergrading?.enterWorkspace) await window.peergrading.enterWorkspace(); else location.assign("/app"); }
  function showLogin() {
    ++loadSequence; data = null; currentOrder = null; clearTimeout(paymentTimer); stopPending();
    $("#checkout").hidden = true; $("#loading").hidden = true; $("#account").hidden = true; $("#login").hidden = false; $("#workspace").hidden = true;
  }
  function showPending(request) {
    pending = request;
    $("#sign-in").disabled = true; $("#login-wait").hidden = false; $("#login-status").textContent = t("wait"); $("#pair-code").textContent = request.userCode || "—";
    clearTimeout(loginTimer); loginTimer = setTimeout(pollLogin, 3000);
  }
  function stopPending(status) {
    pending = null; clearTimeout(loginTimer); $("#sign-in").disabled = false; $("#login-wait").hidden = true; $("#pair-code").textContent = "—";
    if (status) notice(errorText(status), status !== "denied");
  }
  async function pollLogin() {
    if (!pending) return;
    if (Date.now() >= pending.expiresAt) return stopPending("expired");
    try {
      const status = await api("/api/local/auth/status");
      if (status.paired || status.status === "approved") { stopPending(); await load(); await workspace(); return; }
      if (["expired","denied","consumed","error"].includes(status.status)) return stopPending(status.lastError || status.status);
    } catch (e) { notice(errorText(e.message), true); }
    loginTimer = setTimeout(pollLogin, 3000);
  }
  async function load() {
    const sequence = ++loadSequence;
    try {
      const fresh = await api("/api/auth/bootstrap"); if (sequence !== loadSequence) return;
      boot = fresh;
      $("#cloud-url").value = boot.cloudUrl === boot.cloudDefault ? "" : boot.cloudUrl || "";
      if (!boot.user) { showLogin(); if (boot.pairing?.status === "pending") showPending(boot.pairing); else stopPending(); if (boot.lastError) notice(boot.lastError, true); return; }
      let details;
      try { details = await api("/api/local/account"); }
      catch (e) { if (e.message === "unauthenticated" || !boot.user) return; details = {user:boot.user,plan:boot.plan,orders:[],devices:[]}; notice(t("offline"), true); }
      if (sequence !== loadSequence) return;
      data = details; renderAccount();
    } catch (e) { if (sequence !== loadSequence) return; showLogin(); notice(errorText(e.message), true); }
  }
  function renderAccount() {
    const u = data.user, access = u.access || {}, trial = access.trial || {};
    $("#loading").hidden = true; $("#login").hidden = true; $("#account").hidden = false; $("#workspace").hidden = false;
    const badge = access.beta ? t("beta") : access.permanent ? t("permanent") : access.member ? t("member") : access.allowed ? t("trial") : t("accessEnded");
    const status = node("div", {className:"profile-status"}, node("span", {className:"status-badge",textContent:badge}));
    if (!access.beta && !access.permanent) status.append(node("p", {className:"fine",textContent:`${t("daysLeft")} ${access.daysLeft ?? trial.daysLeft ?? 0}${access.member ? "" : ` · ${t("runsLeft")} ${trial.usesLeft ?? "—"}`}`}));
    $("#profile").replaceChildren(node("div", {}, node("p", {className:"profile-name",textContent:u.name || t("user")}), node("p", {className:"profile-meta",textContent:`${t("accountId")} ${u.id} · ${t("created")} ${date(u.createdAt)}`})), status);
    renderPlans(); renderOrders(); renderReferral(); renderDevices();
  }
  function planName(plan) { return words[language]?.[plan.code] ? t(plan.code) : plan.name || plan.code; }
  function renderPlans() {
    const plan = data.plan || {}, access = data.user.access || {};
    $("#beta-note").textContent = plan.beta ? t("betaNote") : "";
    $("#plans").replaceChildren(...(plan.plans || []).map((p) => {
      const buy = action(plan.beta ? t("afterBeta") : access.permanent ? t("hasMember") : p.limit != null && p.left <= 0 ? t("soldOut") : access.member && p.mode === "days" ? t("renew") : t("buy"), async () => { const r = await api("/api/local/account/orders", {plan:p.code}); showOrder(r.order); await refreshOrders(); }, "button primary");
      buy.disabled = !!plan.beta || !!access.permanent || (p.limit != null && p.left <= 0);
      return node("div", {className:"plan"}, node("h3", {textContent:planName(p)}), node("div", {className:"price"}, money(p.priceCents,p.currency), node("small", {textContent:p.mode === "permanent" ? t("oneTime") : `${p.days} ${language === "zh" ? "天" : "days"}`})), node("p", {className:"fine",textContent:p.limit != null ? `${t("slots")} ${p.left}` : t("monthly")}), buy);
    }));
  }
  async function refreshOrders() { await load(); }
  function renderOrders() {
    const orders = data.orders || [];
    $("#orders").replaceChildren(...(orders.length ? orders.map((o) => {
      const no = o.no || o.merchant_order_no;
      const description = node("div", {}, node("strong", {className:"mono",textContent:no}), node("div", {className:"sub",textContent:`${money(o.amountCents ?? o.amount_cents,o.currency)} · ${date(o.createdAt ?? o.created_at)} · ${o.status === "paid" ? t("orderPaid") : o.status === "pending" ? t("orderPending") : t("orderClosed")}`}));
      return node("div", {className:"row"}, description, action(t("viewOrder"), async () => { const d = await api(`/api/local/account/orders/${encodeURIComponent(no)}`); showOrder(d.order); }));
    }) : [node("p", {className:"muted",textContent:t("noOrders")})]));
  }
  function showOrder(order) {
    if (!order) throw new Error("failed");
    clearTimeout(paymentTimer); currentOrder = order;
    const host = $("#checkout"); host.hidden = false;
    const methods = node("div", {className:"actions"}), result = node("div", {id:"checkout-result"});
    host.replaceChildren(node("p", {className:"eyebrow",textContent:t("orders")}), node("h3", {textContent:`${order.no} · ${money(order.amountCents,order.currency)}`}), methods, result);
    if (order.status === "pending") {
      const providers = (order.paymentProviders || data.paymentProviders || []).filter((p) => p.configured);
      for (const p of providers) {
        const button = action(p.id === "wechat" ? t("wechatPay") : t("cardPay"), async () => {
          const r = await api(`/api/local/account/orders/${encodeURIComponent(order.no)}/checkout`, {provider:p.id});
          for (const b of methods.querySelectorAll("[data-provider]")) if (b !== button) b.disabled = true;
          order.checkoutProvider = p.id;
          if (r.checkout?.kind === "qr") {
            if (typeof r.checkout.qrDataUrl !== "string" || !r.checkout.qrDataUrl.startsWith("data:image/png;base64,")) throw new Error("failed");
            result.replaceChildren(node("p", {textContent:t("scan")}), node("img", {src:r.checkout.qrDataUrl,alt:t("wechatPay")}));
          } else if (r.checkout?.kind === "external") { await external(r.checkout.url); result.replaceChildren(node("p", {textContent:t("cardOpened")})); }
          else throw new Error("failed");
          pollOrder(order.no, 0);
        }, "button primary");
        button.dataset.provider = p.id; button.disabled = !!order.checkoutProvider && order.checkoutProvider !== p.id; methods.append(button);
      }
      if (!providers.length) result.append(node("p", {className:"muted",textContent:t("payUnavailable")}));
      methods.append(action(t("checkPayment"), async () => {
        const fresh = await api(`/api/local/account/orders/${encodeURIComponent(order.no)}/sync`, {});
        if (fresh.order?.status === "paid") { notice(t("paid")); host.hidden = true; clearTimeout(paymentTimer); currentOrder = null; await load(); }
        else notice(t("waitingPayment"));
      }));
    } else result.append(node("p", {textContent:order.status === "paid" ? t("orderPaid") : t("orderClosed")}));
    methods.append(action(t("close"), () => { host.hidden = true; currentOrder = null; clearTimeout(paymentTimer); }, "text-button"));
    host.scrollIntoView({behavior:"smooth",block:"center"});
  }
  async function pollOrder(no, attempt) {
    clearTimeout(paymentTimer);
    if (!currentOrder || currentOrder.no !== no || attempt >= 120) return;
    try {
      if (!document.hidden) {
        const r = await api(`/api/local/account/orders/${encodeURIComponent(no)}`);
        if (r.order?.status === "paid") { notice(t("paid")); $("#checkout").hidden = true; currentOrder = null; await load(); return; }
      }
    } catch {}
    paymentTimer = setTimeout(() => pollOrder(no, attempt + 1), 5000);
  }
  function renderReferral() {
    const r = data.referral, host = $("#referral-content"); host.replaceChildren(); if (!r) return;
    host.append(node("p", {className:"muted",textContent:`${t("referralLead")} ${r.days} ${language === "zh" ? "天" : "days"}`}), node("div", {className:"invite-code",textContent:r.code}), action(t("copy"), async () => { await navigator.clipboard.writeText(r.code); notice(t("copied")); }));
    host.append(node("p", {className:"fine",textContent:`${t("referralStats")}: ${r.invited} / ${r.earnedDays}${r.pendingDays ? ` · ${t("pendingDays")} ${r.pendingDays}` : ""}`}));
    if (r.claimed) host.append(node("p", {className:"fine",textContent:`${t("claimed")} · ${r.claimed.days} ${language === "zh" ? "天" : "days"}`}));
    else if (r.canClaim) {
      const input = node("input", {placeholder:t("claimPlaceholder"),maxLength:12,autocomplete:"off"});
      host.append(node("div", {className:"claim"}, input, action(t("claim"), async () => { await api("/api/local/account/referral/claim", {code:input.value}); await load(); })));
    }
  }
  function renderDevices() {
    const identities = $("#identities"), devices = $("#devices"); identities.replaceChildren(); devices.replaceChildren();
    for (const identity of data.user.identities || []) identities.append(node("p", {className:"fine",textContent:`${identity.provider === "wechat" ? (language === "zh" ? "微信" : "WeChat") : identity.provider === "google" ? "Google" : identity.provider} · ${identity.display_name || "—"}`}));
    if (data.securityUrl) identities.append(action(t("securityManage"), () => external(data.securityUrl), "text-button"), node("p", {className:"fine",textContent:t("securityNote")}));
    for (const d of data.devices || []) devices.append(node("div", {className:"row"}, node("div", {}, node("strong", {textContent:d.deviceName || "PeerGrading"}), node("div", {className:"sub",textContent:d.current ? t("deviceCurrent") : date(d.lastSeenAt)})), action(t("revoke"), async () => {
      if (!confirm(t("confirmRevoke"))) return;
      const r = await api("/api/local/account/devices/revoke", {id:d.id});
      if (r.current) { await api("/api/local/auth/logout", {}); data = null; boot.user = null; showLogin(); }
      else await load();
    }, "text-button")));
  }
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-k]").forEach((e) => { e.textContent = t(e.dataset.k); });
  document.querySelectorAll("[data-language]").forEach((b) => { b.classList.toggle("active",b.dataset.language === language); b.onclick = () => { try { localStorage.setItem("lang",b.dataset.language); } catch {} location.reload(); }; });
  $("#workspace").onclick = workspace;
  $(".brand").onclick = (event) => { if (data?.user) { event.preventDefault(); workspace(); } };
  $("#sign-in").onclick = async () => {
    $("#sign-in").disabled = true; notice("");
    try { if (boot.paired) await api("/api/local/auth/logout", {}); const request = await api("/api/local/auth/start", {}); showPending(request); await external(request.verificationUrl); }
    catch (e) { notice(errorText(e.message), true); if (!pending) $("#sign-in").disabled = false; }
  };
  $("#login-reopen").onclick = async () => { if (pending) try { await external(pending.verificationUrl); } catch (e) { notice(errorText(e.message),true); } };
  $("#login-cancel").onclick = async () => { try { await api("/api/local/auth/logout", {}); stopPending("denied"); } catch (e) { notice(errorText(e.message),true); } };
  $("#refresh").onclick = async () => { $("#refresh").disabled = true; notice(""); try { await load(); } finally { $("#refresh").disabled = false; } };
  $("#sign-out").onclick = async () => { if (!confirm(t("confirmSignOut"))) return; ++loadSequence; $("#sign-out").disabled = true; try { await api("/api/local/auth/logout", {}); boot.user = null; boot.paired = false; showLogin(); notice(t("loggedOut")); } catch (e) { notice(errorText(e.message),true); } finally { $("#sign-out").disabled = false; } };
  $("#cloud-save").onclick = async () => { try { await api("/api/local/cloud", {url:$("#cloud-url").value}); stopPending(); await load(); notice(t("cloudSaved")); } catch (e) { notice(errorText(e.message),true); } };
  for (const page of ["terms","privacy"]) $("#"+page).onclick = (e) => { e.preventDefault(); external(cloudAddress("/"+page)).catch((error) => notice(errorText(error.message),true)); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && pending) { clearTimeout(loginTimer); pollLogin(); } });
  window.addEventListener("focus", () => { if (!pending && data) load(); });
  load();
})();
