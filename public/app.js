const $ = (s) => document.querySelector(s);
let lang = (() => { try { return localStorage.getItem("lang") || (navigator.language.startsWith("zh") ? "zh" : "en"); } catch { return "zh"; } })();
const t = (k) => window.I18N[lang][k];
const IS_WIN = /Windows/i.test(navigator.userAgent);   // 粘贴快捷键提示用

let agents = [];
let csrf = "", me = null;
const _fetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (opts.method && opts.method !== "GET") opts.headers = { ...(opts.headers || {}), "x-csrf-token": csrf };
  return _fetch(url, opts).then((r) => { if (r.status === 401 && String(url).startsWith("/api/")) location.assign(localMode ? "/account" : "/?login=required"); return r; });
};
let localMode = false, cloudUrl = "";
async function bootstrapAuth() {
  const r = await _fetch("/api/auth/bootstrap"); const d = await r.json();
  csrf = d.csrf; me = d.user; localMode = !!d.localMode; cloudUrl = d.cloudUrl || "";
  if (!me) { location.assign(localMode ? "/account" : "/?login=required"); return false; }
  if (localMode) {
    for (const link of document.querySelectorAll('.titlebar a[href="/account"], #paywall a')) {
      link.href = "/account" + (link.closest("#paywall") ? "#pricing" : "");
      link.onclick = (event) => { if (window.peergrading?.openAccount) { event.preventDefault(); window.peergrading.openAccount(link.hash); } };
    }
    const lo = $("#logout-btn"); if (lo) { lo.onclick = async () => { if (!confirm(t("unpairConfirm"))) return; await fetch("/api/local/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); location.assign("/account"); }; }
  }
  renderAccess(); return true;
}
function renderAccess() {
  const b = $("#access-badge"); if (!b || !me) return;
  const a = me.access;
  b.className = "access" + (a.member ? " member" : "");
  b.textContent = a.member ? t("memberBadge") : a.beta ? t("betaBadge") : t("trialBadge")(a.trial.daysLeft, a.trial.usesLeft);
}
function showPaywall(access) {
  const p = $("#paywall"); if (!p) return;
  $("#paywall-text").textContent = access?.reason === "trial_expired" ? t("paywallExpired") : t("paywallExhausted");
  p.classList.add("open");
}
$("#close-paywall") && ($("#close-paywall").onclick = () => $("#paywall").classList.remove("open"));
$("#logout-btn") && ($("#logout-btn").onclick = async () => { await fetch("/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); location.assign("/"); });
const chosen = { A: null, B: null };
let pickingSlot = null;
let runId = null, controller = null;
const msgs = new Map();
const versions = [];
let repositoryRun = false, repositoryManifest = null, diffRequest = 0;

marked.setOptions({ breaks: true });
/** 协作中生成的图片 / 视频以 media://文件名 引用，渲染时指向当前会话的媒体接口。在渲染器层做映射，代码块 / 行内代码里的引用原样保留 */
const mediaUrl = (file) => `/api/sessions/${encodeURIComponent(currentSessionId || "")}/media/${encodeURIComponent(file)}`;
const MEDIA_REF = /^media:\/\/([A-Za-z0-9._-]+)$/;
marked.use({ renderer: {
  image(href, title, text) {
    const m = MEDIA_REF.exec(href || ""); if (!m) return false;
    const file = m[1], t = title ? ` title="${esc(title)}"` : "";
    if (/\.(mp4|webm)$/i.test(file)) return `<video class="media" controls preload="metadata" src="${mediaUrl(file)}" title="${esc(text)}"></video>`;
    return `<img class="media" src="${mediaUrl(file)}" alt="${esc(text)}"${t}>`;
  },
  link(href, title, text) {
    const m = MEDIA_REF.exec(href || ""); if (!m) return false;
    return `<a href="${mediaUrl(m[1])}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ""}>${text}</a>`;
  },
} });
function render(md) {
  const src = md.replace(/<deliverable>/gi, '\n\n<div class="deliv">\n\n').replace(/<\/deliverable>/gi, '\n\n</div>\n\n');
  const html = marked.parse(src);
  return DOMPurify.sanitize(html, { ADD_ATTR: ["class", "controls", "preload", "target"] });
}
const tx = (v) => (v && typeof v === "object" ? v[lang] : v ?? "");
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ---------- 语言 ---------- */
function applyI18n() {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  document.querySelectorAll("#lang-seg button").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
  $("#history").options[0] && ($("#history").options[0].textContent = t("historyPh"));
  if (!msgs.size) $("#timeline").innerHTML = `<p class="sys">${esc(t("timelineEmpty"))}</p>`;
  if (!versions.length) $("#version-body").innerHTML = `<p class="sys">${esc(t("versionsEmpty"))}</p>`;
  renderSlot("A"); renderSlot("B"); renderCards(); renderRepository();
}
$("#lang-seg").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  lang = b.dataset.lang; try { localStorage.setItem("lang", lang); } catch {}
  applyI18n();
  if (mediaCfg) renderMediaSettings();   // 侧栏的媒体提示与占位文字是程序写入的，随语言一起刷新
};

/* ---------- 智能体检测与选择 ---------- */
async function loadAgents(refresh = false) {
  $("#cards").innerHTML = `<p class="sys">${esc(t("detecting"))}</p>`;
  const r = await fetch("/api/agents" + (refresh ? "?refresh=1" : ""));
  agents = (await r.json()).agents;
  // 若已选的智能体状态变化，同步
  for (const k of ["A", "B"]) if (chosen[k]) chosen[k] = agents.find((a) => a.id === chosen[k].id) || chosen[k];
  // 默认：A 选第一个可用的云端，B 选第一个可用的本地；否则前两个
  if (!chosen.A && !chosen.B) {
    const ready = agents.filter((a) => a.status === "ready" || a.status === "unverified");
    const autos = ready.filter((a) => a.auto);
    chosen.A = autos[0] || ready[0] || null;
    chosen.B = autos.find((a) => a !== chosen.A) || ready.find((a) => a !== chosen.A) || null;
    for (const k of ["A", "B"]) if (chosen[k]?.runner?.app) $("#app-" + k).value = chosen[k].runner.app;
  }
  renderSlot("A"); renderSlot("B"); renderCards();
}
function statusLabel(a) { return t("st_" + a.status); }
function renderSlot(k) {
  const el = $("#pick-" + k), a = chosen[k];
  el.classList.toggle("filled", Boolean(a));
  el.innerHTML = a
    ? `<div class="ic">${esc(a.icon)}</div><div class="txt"><div class="t">${esc(tx(a.title))} ${a.auto ? `<span class="badge auto">${t("autoBadge")}</span>` : `<span class="badge manual">${t("manualBadge")}</span>`}</div><div class="m"><span class="dot ${a.status}"></span>${esc(statusLabel(a))} · ${esc(tx(a.subtitle))}</div></div><span class="chg">${esc(t("change"))}</span>`
    : `<div class="ic">?</div><div class="txt"><div class="t">${esc(t("choose"))}</div></div>`;
  el.onclick = () => openSheet(k);
  $("#effort-row-" + k).hidden = !(a && a.runner?.type === "anthropic");
  $("#app-row-" + k).hidden = !(a && a.kind === "relay");
}
function openSheet(k) { pickingSlot = k; $("#sheet").classList.add("open"); renderCards(); }
function closeSheet() { $("#sheet").classList.remove("open"); pickingSlot = null; }
$("#close-sheet").onclick = closeSheet;
$("#sheet").onclick = (e) => { if (e.target === $("#sheet")) closeSheet(); };
$("#refresh").onclick = () => loadAgents(true);

function renderCards() {
  const box = $("#cards");
  const shown = agents.filter((a) => !isRepositoryMode() || ["claude-code", "codex", "kimi-code"].includes(a.runner?.type));
  if (!shown.length) { box.innerHTML = `<p class="sys">${esc(t(isRepositoryMode() ? "repoAgentsRequired" : "none"))}</p>`; return; }
  box.innerHTML = "";
  let lastGroup = null;
  for (const a of shown) {
    const group = a.auto ? "auto" : "manual";
    if (group !== lastGroup) { lastGroup = group; const h = document.createElement("div"); h.className = "group"; h.textContent = t(group === "auto" ? "groupAuto" : "groupManual"); box.appendChild(h); }
    const card = document.createElement("div");
    card.className = "card" + (pickingSlot && chosen[pickingSlot]?.id === a.id ? " selected" : "");
    let detail = a.statusDetail ? `<div class="d">${esc(tx(a.statusDetail))}</div>` : "";
    if (a.hintCommand) detail += `<div class="d">${esc(t("loginHint"))} <kbd>${esc(tx(a.hintCommand))}</kbd></div>`;
    let side = "";
    if (a.status === "server_off" && a.service) side += `<button class="btn sm primary" data-start="${a.service}">${esc(t("startService"))}</button>`;
    if (a.status === "not_logged_in" && a.kind === "cli") side += `<button class="btn sm primary" data-login="${esc(a.id)}">${esc(t("loginBtn"))}</button>`;
    if (a.hintCommand) side += `<button class="btn sm" data-copy="${esc(tx(a.hintCommand))}">${esc(t("copyCmd"))}</button>`;
    const netBadge = (a.auto ? `<span class="badge auto">${t("autoBadge")}</span>` : `<span class="badge manual">${t("manualBadge")}</span>`) + (a.kind === "relay" && !a.runner?.app ? "" : `<span class="badge ${a.local ? "local" : "cloud"}">${t(a.local ? "local" : "cloud")}</span>`);
    card.innerHTML = `<div class="ic">${esc(a.icon)}</div>
      <div><div class="t">${esc(tx(a.title))} ${netBadge}<span class="badge"><span class="dot ${a.status}"></span>${esc(statusLabel(a))}</span></div>
      <div class="m">${esc(tx(a.subtitle))}</div>${detail}</div>
      <div class="side">${side}</div>`;
    card.onclick = (e) => {
      const b = e.target.closest("button");
      if (b?.dataset.start) return startService(b, b.dataset.start);
      if (b?.dataset.login) return openLogin(b, b.dataset.login);
      if (b?.dataset.copy) { navigator.clipboard?.writeText(b.dataset.copy); b.textContent = t("copied"); return; }
      if (!pickingSlot) return;
      chosen[pickingSlot] = a; renderSlot(pickingSlot);
      if (a.runner?.app) $("#app-" + pickingSlot).value = a.runner.app;
      closeSheet();
    };
    box.appendChild(card);
  }
}
async function openLogin(btn, id) {
  btn.disabled = true;
  const r = await fetch("/api/agents/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  const j = await r.json();
  if (!r.ok) { btn.disabled = false; alert(j.message); return; }
  btn.textContent = t("loginOpened");
  const note = document.createElement("div"); note.className = "d"; note.textContent = t("loginNote")[j.note] || "";
  btn.closest(".card").querySelector(".m").after(note);
}
async function startService(btn, service) {
  btn.disabled = true; btn.textContent = t("starting");
  const r = await fetch("/api/services/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service }) });
  const j = await r.json();
  if (!r.ok) { btn.disabled = false; btn.textContent = t("startService"); alert(j.message); return; }
  await loadAgents(true);
}

/* ---------- Existing repository collaboration ---------- */
const isRepositoryMode = () => $("#work-mode").value === "repository";
function repositoryError(code) {
  if (/repository_dirty|未提交|dirty/i.test(code)) return t("repoDirty");
  if (/repository_agents_required/.test(code)) return t("repoAgentsRequired");
  if (/repository_local_only/.test(code)) return t("repoLocalOnly");
  if (/check_|invalid_check/.test(code)) return t("repoInvalidCommand");
  return code;
}
async function loadRepositoryAvailability() {
  try {
    const r = await fetch("/api/repositories/status"); const d = await r.json();
    $("#work-mode option[value=repository]").disabled = !d.available;
    $("#repository-browse").hidden = !d.available || !window.peergrading?.chooseRepository;
  } catch {}
}
function updateRepositoryMode() {
  $("#repository-config").hidden = !isRepositoryMode();
  $("#media-images").closest(".media-opts").hidden = isRepositoryMode();
  document.querySelector('[data-i18n="mediaTitle"]').hidden = isRepositoryMode();
  if (isRepositoryMode()) {
    const ready = agents.filter((a) => ["claude-code", "codex", "kimi-code"].includes(a.runner?.type) && ["ready", "unverified"].includes(a.status));
    for (const k of ["A", "B"]) if (!chosen[k] || !["claude-code", "codex", "kimi-code"].includes(chosen[k].runner?.type)) chosen[k] = ready.find((a) => a !== chosen.A) || ready[0] || null;
    renderSlot("A"); renderSlot("B");
  }
  renderCards();
}
async function inspectRepository() {
  const path = $("#repository-path").value.trim();
  if (!path) { $("#repository-info").textContent = t("repoNeedPath"); return; }
  const r = await fetch("/api/repositories/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  const d = await r.json();
  $("#repository-info").textContent = r.ok ? `${d.repository.branch || "HEAD"} · ${d.repository.head.slice(0, 8)} · ${d.repository.dirty ? t("repoDirty") : t("repoClean")}` : repositoryError(d.error || String(r.status));
  if (r.ok) $("#repository-path").value = d.repository.path;
}
$("#work-mode").onchange = updateRepositoryMode;
$("#repository-inspect").onclick = () => inspectRepository().catch((e) => { $("#repository-info").textContent = e.message; });
$("#repository-browse").onclick = async () => {
  try { const path = await window.peergrading?.chooseRepository(); if (path) { $("#repository-path").value = path; await inspectRepository(); } }
  catch (e) { $("#repository-info").textContent = e.message; }
};
async function refreshRepositoryResult() {
  if (!repositoryRun || !currentSessionId) return;
  try { const r = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/repository`); if (r.ok) { repositoryManifest = (await r.json()).repository; renderRepository(); } } catch {}
}
function renderRepository() {
  const box = $("#repository-result"); if (!box) return;
  box.hidden = !repositoryManifest; if (!repositoryManifest) return;
  const m = repositoryManifest;
  $("#repository-location").textContent = `${t("repoBranch")}: ${m.branch || ""}\n${t("repoWorktree")}: ${m.worktreePath || ""}\n${t("repoStatuses")[m.status] || m.status || ""}`;
  const snapshot = m.snapshots?.find((v) => v.n === currentVersion);
  const checks = snapshot?.checks || m.checks || [];
  $("#repository-checks").replaceChildren(...checks.map((c) => {
    const row = document.createElement("div"); row.className = "repository-check";
    const ok = c.ok ?? c.passed ?? c.code === 0;
    row.textContent = `${ok ? "✓" : "✗"} ${(c.argv || c.command?.argv || []).join(" ")}${c.timedOut ? " (timeout)" : ""}`;
    if (c.stdout || c.stderr) { const details = document.createElement("details"), title = document.createElement("summary"), output = document.createElement("pre"); title.textContent = lang === "zh" ? "查看输出" : "Output"; output.textContent = (c.stdout || "") + (c.stderr || ""); details.append(title, output); row.append(details); }
    return row;
  }));
  const link = $("#repository-patch"); link.hidden = !snapshot || !currentSessionId;
  if (snapshot && currentSessionId) {
    link.download = `version-${currentVersion}.patch`;
    link.href = `/api/sessions/${encodeURIComponent(currentSessionId)}/repository/versions/${currentVersion}.patch`;
    const request = ++diffRequest;
    fetch(link.href).then((r) => r.ok ? r.text() : "").then((text) => { if (request === diffRequest) $("#repository-diff").textContent = text.slice(0, 150_000); }).catch(() => {});
  }
}

/* ---------- 运行 ---------- */
function resetView() {
  $("#timeline").innerHTML = ""; $("#tabs").innerHTML = ""; $("#version-body").innerHTML = ""; $("#final").textContent = "";
  msgs.clear(); versions.length = 0; currentVersion = 0; currentSessionId = null;
  repositoryManifest = null; repositoryRun = false; ++diffRequest; $("#repository-result").hidden = true; $("#repository-diff").textContent = "";
  if ($("#finalizer")) { $("#finalizer").hidden = true; $("#fin-log").innerHTML = ""; $("#fin-result").innerHTML = ""; }
}
function setRunning(on) { $("#start").disabled = on; $("#stop").disabled = !on; for (const id of ["work-mode", "repository-path", "repository-tests", "repository-browse", "repository-inspect", "history"]) $("#" + id).disabled = on; renderFinalizer(); }
function scrollBottom() { const tl = $("#timeline"); tl.scrollTop = tl.scrollHeight; }

function handle(ev) {
  const tl = $("#timeline");
  switch (ev.type) {
    case "run": runId = ev.id; currentSessionId = ev.id; break;
    case "repository_ready": repositoryRun = true; repositoryManifest = ev.repository; renderRepository(); break;
    case "repository_snapshot":
      if (repositoryManifest) { repositoryManifest.snapshots ||= []; const i = repositoryManifest.snapshots.findIndex((x) => x.n === ev.snapshot.n); if (i >= 0) repositoryManifest.snapshots[i] = ev.snapshot; else repositoryManifest.snapshots.push(ev.snapshot); repositoryManifest.finalCommit = ev.snapshot.commit; }
      renderRepository(); break;
    case "repository_check":
      if (repositoryManifest) { repositoryManifest.checks ||= []; repositoryManifest.checks.push(ev.check); } renderRepository(); break;
    case "status": { const p = document.createElement("p"); p.className = "sys"; p.textContent = ev.text; tl.appendChild(p); $("#status").textContent = ev.text; scrollBottom(); break; }
    case "message_start": {
      const el = document.createElement("div"); el.className = "msg " + ev.agent;
      el.innerHTML = `<div class="avatar">${ev.agent}</div><div class="bubble"><div class="meta"><b>${esc(ev.name)}</b><span class="tag">${esc(t("round")(ev.round))} · ${esc(t("kinds")[ev.kind] || ev.kind)}</span><span class="tag">${esc(ev.source || ev.model)}</span><span class="verdict"></span></div><div class="body cursor"></div><div class="usage"></div></div>`;
      tl.appendChild(el);
      const prog = document.createElement("div"); prog.className = "prog"; el.querySelector(".bubble").insertBefore(prog, el.querySelector(".body"));
      const m = { el, body: el.querySelector(".body"), text: "", raf: 0, started: Date.now(), prog, phase: "waiting", chars: 0, timer: 0 };
      const tick = () => { const sec = Math.round((Date.now() - m.started) / 1000); prog.textContent = m.phase === "reasoning" ? t("reasoning")(sec, m.chars) : m.phase === "running" ? t("runningCli")(sec) : t("waiting")(sec); };
      tick(); m.timer = setInterval(tick, 1000);
      msgs.set(ev.id, m);
      scrollBottom(); break;
    }
    case "progress": {
      const m = msgs.get(ev.id); if (!m) break;
      m.phase = ev.phase; if (ev.chars) m.chars = ev.chars;
      break;
    }
    case "delta": {
      const m = msgs.get(ev.id); if (!m) break;
      if (m.timer) { clearInterval(m.timer); m.timer = 0; m.prog.remove(); }
      m.text += ev.text;
      if (!m.raf) m.raf = requestAnimationFrame(() => { m.raf = 0; m.body.innerHTML = render(m.text); scrollBottom(); });
      break;
    }
    case "message_end": {
      const m = msgs.get(ev.id); if (!m) break;
      if (m.timer) { clearInterval(m.timer); m.timer = 0; m.prog.remove(); }
      if (typeof ev.text === "string") m.text = ev.text;   // 媒体围栏已替换为图片 / 视频引用
      m.body.classList.remove("cursor"); m.body.innerHTML = render(m.text);
      if (ev.verdict) { const v = m.el.querySelector(".verdict"); v.className = "tag verdict " + (ev.verdict === "approve" ? "ok" : "warn"); v.textContent = t(ev.verdict); }
      if (ev.usage) m.el.querySelector(".usage").textContent = t("tokens")(ev.usage.input, ev.usage.output);
      break;
    }
    case "media_start": {
      const m = msgs.get(ev.id); if (!m) break;
      if (!m.mediaBox) { m.mediaBox = document.createElement("div"); m.mediaBox.className = "media-status"; m.body.after(m.mediaBox); m.mediaRows = new Map(); }
      const row = document.createElement("div"); row.dataset.kind = ev.kind; row.textContent = t("mediaGenerating")(t("mediaKind")[ev.kind] || ev.kind);
      m.mediaBox.appendChild(row); m.mediaRows.set(ev.mediaId, row); scrollBottom(); break;
    }
    case "media_progress": {
      const row = msgs.get(ev.id)?.mediaRows?.get(ev.mediaId); if (!row) break;
      row.textContent = t("mediaProgress")(t("mediaKind")[row.dataset.kind] || row.dataset.kind, ev.status, ev.percent); break;
    }
    case "media_end": {
      const m = msgs.get(ev.id); const row = m?.mediaRows?.get(ev.mediaId); if (!row) break;
      if (ev.ok) { row.remove(); m.mediaRows.delete(ev.mediaId); }
      else { row.classList.add("err"); row.textContent = t("mediaFailed")(t("mediaKind")[ev.kind] || ev.kind, ev.error || ""); m.mediaRows.delete(ev.mediaId); }
      if (m.mediaBox && !m.mediaBox.childElementCount) { m.mediaBox.remove(); m.mediaBox = null; }
      break;
    }
    case "version": {
      versions.push(ev);
      const b = document.createElement("button"); b.className = "btn sm"; b.textContent = t("vTab")(ev.n, ev.name);
      b.onclick = () => showVersion(ev.n); $("#tabs").appendChild(b); showVersion(ev.n);
      break;
    }
    case "relay_wait": {
      const m = msgs.get(ev.id); if (!m) break;
      if (m.timer) { clearInterval(m.timer); m.timer = 0; m.prog.remove(); }
      m.body.classList.remove("cursor");
      const panel = document.createElement("div"); panel.className = "relay";
      panel.innerHTML = `<div class="rt">${esc(t("relayTitle")(ev.name))}</div>
        ${ev.first ? `<div class="rn">${esc(t("relayFirst"))}</div>` : ""}
        <div class="rn">${esc(ev.mode === "clipboard" ? t("relayClip") : t("relayManual"))}</div>
        <pre class="rtext"></pre>
        <div class="rrow"><button class="btn sm primary" data-act="send"></button><button class="btn sm" data-act="copy">${esc(t("relayCopy"))}</button><span class="rwait">${esc(t("relayWaiting"))}</span></div>
        <textarea rows="4" placeholder="${esc(t("relayPaste"))}"></textarea>
        <div class="rrow"><button class="btn sm primary" data-act="submit">${esc(t("relaySubmit"))}</button></div>`;
      panel.querySelector(".rtext").textContent = ev.text;
      const app = ($("#app-" + ev.agent)?.value || ev.app || "").trim();
      const sendBtn = panel.querySelector('[data-act="send"]');
      sendBtn.textContent = t("relaySend")(app);
      sendBtn.onclick = async () => {
        sendBtn.disabled = true;
        const r = await fetch("/api/relay/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: ev.requestId, text: ev.text, app }) }).then((x) => x.json()).catch(() => null);
        // 服务端返回 ok:false 时文本已复制（只是没切到应用）；请求本身失败则什么都没发生
        sendBtn.textContent = !r ? t("relayRequestFailed") : !app ? t("copied") : r.ok ? t("relaySent")(IS_WIN) : r.message === "not running" ? t("relayNotRunning")(app) : t("relayFailed")(r.message || "");
        sendBtn.disabled = false;
      };
      panel.querySelector('[data-act="copy"]').onclick = (e) => { navigator.clipboard?.writeText(ev.text); e.target.textContent = t("copied"); };
      panel.querySelector('[data-act="submit"]').onclick = async (e) => {
        const text = panel.querySelector("textarea").value.trim(); if (!text) return;
        e.target.disabled = true;
        await fetch("/api/relay/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: ev.requestId, text }) });
      };
      m.body.innerHTML = ""; m.body.appendChild(panel); m.relay = panel; scrollBottom();
      break;
    }
    case "relay_candidate": {
      const m = msgs.get(ev.id); if (!m || !m.relay) break;
      m.relay.querySelector(".cand")?.remove();
      const box = document.createElement("div"); box.className = "cand";
      box.innerHTML = `<div class="rt">${esc(t("candTitle"))}</div><pre class="rtext"></pre><div class="rrow"><button class="btn sm primary" data-act="accept">${esc(t("candAccept"))}</button><button class="btn sm" data-act="reject">${esc(t("candReject"))}</button><span class="rwait cd"></span></div>`;
      box.querySelector(".rtext").textContent = ev.text;
      let n = 6; const cd = box.querySelector(".cd"); cd.textContent = t("candCountdown")(n);
      const submit = async () => { clearInterval(tick); box.remove(); await fetch("/api/relay/reply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: ev.requestId, text: ev.text }) }); };
      const tick = setInterval(() => { n--; cd.textContent = t("candCountdown")(n); if (n <= 0) submit(); }, 1000);
      box.querySelector('[data-act="accept"]').onclick = submit;
      box.querySelector('[data-act="reject"]').onclick = async () => { clearInterval(tick); box.remove(); await fetch("/api/relay/ignore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: ev.requestId, text: ev.text }) }); };
      m.relay.appendChild(box); scrollBottom();
      break;
    }
    case "relay_done": {
      const m = msgs.get(ev.id); if (!m) break;
      m.relay?.remove(); m.relay = null; m.body.classList.add("cursor");
      break;
    }
    case "done": $("#final").textContent = "✓ " + ev.reason; showVersion(ev.finalVersion); setTimeout(renderFinalizer, 300); break;
    case "error": {
      for (const m of msgs.values()) { m.body.classList.remove("cursor"); if (m.timer) { clearInterval(m.timer); m.timer = 0; } }
      settleMediaRows();
      const p = document.createElement("p"); p.className = "sys err"; p.textContent = t("error") + ev.message; tl.appendChild(p);
      $("#status").innerHTML = `<span class="err">${esc(ev.message)}</span>`; scrollBottom();
      break;
    }
  }
}
/** 协作结束（停止、断线、出错）时还挂着"正在生成…"的行：没有 media_end 会来了，标成已中断 */
function settleMediaRows() {
  for (const m of msgs.values()) {
    if (!m.mediaRows?.size) continue;
    for (const [id, row] of m.mediaRows) { row.classList.add("err"); row.textContent = t("mediaInterrupted")(t("mediaKind")[row.dataset.kind] || row.dataset.kind); m.mediaRows.delete(id); }
  }
}
let currentVersion = 0, currentSessionId = null, finEnv = null, finController = null, finRunId = null;
function showVersion(n) {
  const v = versions.find((x) => x.n === n); if (!v) return;
  currentVersion = n;
  [...$("#tabs").children].forEach((b, i) => b.classList.toggle("active", i === n - 1));
  $("#version-body").innerHTML = render(v.content);
  renderFinalizer(); renderRepository();
}

/* ---------- 收尾 Agent ---------- */
/* ---------- 图片 / 视频生成设置 ---------- */
let mediaCfg = null;
const mediaPref = (() => { try { return JSON.parse(localStorage.getItem("media") || "null"); } catch { return null; } })() || { images: true, videos: false };
async function loadMediaSettings() {
  try { mediaCfg = await (await fetch("/api/media/settings")).json(); } catch { mediaCfg = null; }
  renderMediaSettings();
}
function renderMediaSettings() {
  const c = mediaCfg, hint = $("#media-hint"), box = $("#media-config"), imgs = $("#media-images"), vids = $("#media-videos");
  if (!c) { hint.textContent = ""; box.hidden = true; imgs.disabled = vids.disabled = true; imgs.checked = vids.checked = false; return; }
  imgs.disabled = !c.configured || !c.images; vids.disabled = !c.configured || !c.videos;
  imgs.checked = !imgs.disabled && !!mediaPref.images; vids.checked = !vids.disabled && !!mediaPref.videos;
  hint.textContent = c.configured ? (c.canEdit ? t("mediaReady")(c.keyHint, c.limits.images, c.limits.videos) : t("mediaReadyUser")(c.limits.images, c.limits.videos)) : c.canEdit ? t("mediaNotConfigured") : t("mediaNotConfiguredUser");
  box.hidden = !c.canEdit;
  if (c.canEdit) {
    $("#media-key").value = ""; $("#media-key").placeholder = c.configured ? t("mediaKeyKeep")(c.keyHint) : t("mediaKeyPh");
    $("#media-clear").hidden = c.keySource !== "file";   // 环境变量里的 Key 不能从界面清除
    $("#media-msg").textContent = c.keySource === "env" ? t("mediaKeyEnv") : "";
    $("#media-base").value = c.baseUrl; $("#media-image-model").value = c.imageModel; $("#media-video-model").value = c.videoModel;
    if (!c.configured) box.open = true;
  }
}
async function saveMediaSettings(clear) {
  const body = clear ? { apiKey: "" } : { baseUrl: $("#media-base").value, imageModel: $("#media-image-model").value, videoModel: $("#media-video-model").value };
  const key = $("#media-key").value.trim(); if (!clear && key) body.apiKey = key;
  const r = await fetch("/api/media/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  $("#media-msg").textContent = r.ok ? t("mediaSaved") : t("error") + (j.error || r.status);
  if (r.ok) { mediaCfg = j; renderMediaSettings(); }
}
for (const k of ["images", "videos"]) $("#media-" + k).addEventListener("change", (e) => { mediaPref[k] = e.target.checked; try { localStorage.setItem("media", JSON.stringify(mediaPref)); } catch {} });
$("#media-save").onclick = () => saveMediaSettings(false);
$("#media-clear").onclick = () => saveMediaSettings(true);

async function loadFinEnv() { try { finEnv = await (await fetch("/api/finalize/env")).json(); } catch { finEnv = { docker: false, hostSupported: true }; } renderFinalizer(); }
function renderFinalizer() {
  const box = $("#finalizer"); if (!box) return;
  const show = !repositoryRun && currentVersion > 0 && currentSessionId && !$("#start").disabled;
  box.hidden = !show; if (!show) return;
  const autos = agents.filter((a) => a.auto && (a.status === "ready" || a.status === "unverified"));
  const sel = $("#fin-agent");
  if (!sel.dataset.filled) {
    sel.innerHTML = autos.map((a) => `<option value="${esc(a.id)}">${esc(tx(a.title))}</option>`).join("");
    const pref = autos.find((a) => a.id === chosen.A?.id) || autos.find((a) => a.id === chosen.B?.id) || autos[0];
    if (pref) sel.value = pref.id; sel.dataset.filled = "1";
  }
  const sb = $("#fin-sandbox");
  if (finEnv && !sb.dataset.filled) {
    sb.innerHTML = (finEnv.docker ? `<option value="docker">${esc(t("finDocker"))}</option>` : "") + (finEnv.hostSupported ? `<option value="host">${esc(t("finHost"))}</option>` : "");
    sb.dataset.filled = "1"; sb.onchange = renderFinalizer;
  }
  $("#fin-pull-row").hidden = sb.value !== "docker";
  $("#fin-warn").textContent = !finEnv ? "" : !finEnv.docker ? t("finDockerMissing") + "。" + t("finHostWarn") : sb.value === "host" ? t("finHostWarn") : "";
  $("#fin-run").textContent = t("finRun")(currentVersion);
  $("#fin-run").disabled = !autos.length || !!finController;
  if (!autos.length) $("#fin-warn").textContent = t("finNoAuto");
}
async function runFinalizer() {
  if (!currentSessionId || !currentVersion) return;
  const log = $("#fin-log"), out = $("#fin-result");
  log.className = "fin-log on"; log.innerHTML = ""; out.innerHTML = "";
  finController = new AbortController(); $("#fin-stop").disabled = false; renderFinalizer();
  const line = (stage, msg) => { const d = document.createElement("div"); d.innerHTML = `<b>${esc(stage)}</b> ${esc(msg)}`; log.appendChild(d); log.scrollTop = log.scrollHeight; };
  try {
    const res = await fetch("/api/finalize", { method: "POST", headers: { "Content-Type": "application/json" }, signal: finController.signal,
      body: JSON.stringify({ sessionId: currentSessionId, versionN: currentVersion, agentId: $("#fin-agent").value, sandbox: $("#fin-sandbox").value, maxFixAttempts: $("#fin-fix").value, pull: $("#fin-pull").checked }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); if (res.status === 403 && j.error === "payment_required") showPaywall(j.access); else line("error", j.error || res.status); return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const l of chunk.split("\n")) { if (!l.startsWith("data: ")) continue; const ev = JSON.parse(l.slice(6));
          if (ev.type === "run") { finRunId = ev.runId; line("prepare", `${t("finVersionId")} ${ev.versionId}`); }
          else if (ev.type === "event") line(ev.stage, ev.message);
          else if (ev.type === "error") line("error", ev.message);
          else if (ev.type === "result") renderFinResult(ev.result);
        }
      }
    }
  } catch (e) { if (e.name !== "AbortError") line("error", e.message); }
  finally { finController = null; finRunId = null; $("#fin-stop").disabled = true; renderFinalizer(); }
}
function renderFinResult(r) {
  const out = $("#fin-result");
  const st = t("finStatus")[r.status] || r.status;
  const basis = r.successBasis ? `（${t("finBasis")[r.successBasis]}）` : "";
  const last = r.attempts?.[r.attempts.length - 1];
  const cmds = (last?.results || []).filter((x) => x.stage !== "probe").map((x) => `$ ${x.argv.join(" ")}\n→ exit ${x.exitCode}${x.timedOut ? " (timeout)" : ""} · ${x.durationMs}ms\n${(x.stdout || "").trim().slice(0, 800)}${x.stderr ? "\n[stderr] " + x.stderr.trim().slice(0, 400) : ""}`).join("\n\n");
  const checks = (last?.checks || []).map((c) => `${c.passed ? "✓" : "✗"} ${c.check.kind} ${c.check.value ?? c.check.path ?? (c.check.field || []).join(".")}`).join("\n");
  out.innerHTML = `<div><span class="st ${esc(r.status)}">${esc(t("finDone"))}：${esc(st)}</span> ${esc(basis)}</div><div class="hint">${esc(r.summary || "")}</div>` +
    (r.warnings?.length ? `<div class="hint warn">${esc(r.warnings.join(" "))}</div>` : "") +
    (cmds ? `<pre>${esc(cmds)}</pre>` : "") + (checks ? `<pre>${esc(checks)}</pre>` : "") +
    (r.reportUrl ? `<a href="${esc(r.reportUrl)}" target="_blank" rel="noopener">${esc(t("finReport"))}</a>` : "");
}
$("#fin-run") && ($("#fin-run").onclick = runFinalizer);
$("#fin-stop") && ($("#fin-stop").onclick = async () => { if (finRunId) await fetch("/api/finalize/stop/" + finRunId, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); finController?.abort(); });

async function start() {
  const task = $("#task").value;
  if (!task.trim()) { $("#status").textContent = t("needTask"); return; }
  if (!chosen.A || !chosen.B) { $("#status").textContent = t("needAgents"); return; }
  const slot = (k) => ({ agentId: chosen[k].id, name: $("#name-" + k).value, persona: $("#persona-" + k).value, effort: $("#effort-" + k).value });
  if (isRepositoryMode() && !$("#repository-path").value.trim()) { $("#status").textContent = t("repoNeedPath"); return; }
  if (isRepositoryMode() && ![chosen.A, chosen.B].every((a) => ["claude-code", "codex", "kimi-code"].includes(a.runner?.type))) { $("#status").textContent = t("repoAgentsRequired"); return; }
  const body = { mode: $("#work-mode").value, repository: isRepositoryMode() ? { path: $("#repository-path").value.trim(), testCommands: $("#repository-tests").value } : undefined, task, lang, agentA: slot("A"), agentB: slot("B"), maxRounds: $("#rounds").value, discussionTurns: $("#turns").value,
    media: { images: !isRepositoryMode() && $("#media-images").checked, videos: !isRepositoryMode() && $("#media-videos").checked } };
  resetView(); repositoryRun = body.mode === "repository"; setRunning(true);
  controller = new AbortController();
  try {
    const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && j.error === "payment_required") { showPaywall(j.access); setRunning(false); return; }
      const e = j.error; handle({ type: "error", message: e === "EMPTY_TASK" ? t("needTask") : e === "NO_AGENT" ? t("needAgents") : repositoryError(e || String(res.status)) }); return;
    }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) if (line.startsWith("data: ")) handle(JSON.parse(line.slice(6)));
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") handle({ type: "error", message: e.message });
  } finally {
    for (const m of msgs.values()) { m.body.classList.remove("cursor"); if (m.timer) { clearInterval(m.timer); m.timer = 0; } }
    settleMediaRows();
    setRunning(false); runId = null; loadHistory(); bootstrapAuth(); refreshRepositoryResult();
  }
}
async function stop() { if (runId) await fetch("/api/stop/" + runId, { method: "POST" }); controller?.abort(); handle({ type: "status", text: t("stopped") }); }

async function loadHistory() {
  const list = await (await fetch("/api/sessions")).json();
  $("#history").innerHTML = `<option value="">${esc(t("historyPh"))}</option>` + list.map((s) => `<option>${esc(s)}</option>`).join("");
}
async function replay(id) {
  if (!id) return;
  const s = await (await fetch("/api/sessions/" + id)).json();
  resetView(); currentSessionId = id; repositoryRun = !!s.config.repository;
  $("#work-mode").value = repositoryRun ? "repository" : "text";
  if (repositoryRun) { $("#repository-path").value = s.config.repository.path; $("#repository-tests").value = (s.config.repository.checks || []).map((c) => c.argv.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(" ")).join("\n"); }
  updateRepositoryMode();
  $("#task").value = s.config.task;
  for (const ev of s.events) handle(ev);
  refreshRepositoryResult();
  for (const m of msgs.values()) { m.body.classList.remove("cursor"); if (m.timer) { clearInterval(m.timer); m.timer = 0; m.prog?.remove(); } }
}

/* ---------- 初始化 ---------- */
for (const k of ["A", "B"]) {
  $("#effort-" + k).innerHTML = ["low", "medium", "high", "xhigh", "max"].map((e) => `<option${e === "high" ? " selected" : ""}>${e}</option>`).join("");
}
$("#start").onclick = start;
$("#stop").onclick = stop;
$("#history").onchange = (e) => replay(e.target.value);
applyI18n();
bootstrapAuth().then((ok) => { if (!ok) return; renderAccess(); loadHistory(); loadAgents(); loadFinEnv(); loadMediaSettings(); loadRepositoryAvailability();
fetch("/api/apps").then((r) => r.json()).then((j) => { $("#apps").innerHTML = j.apps.map((a) => `<option value="${esc(a)}">`).join(""); }).catch(() => {});
});
