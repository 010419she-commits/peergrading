// server.ts — Express：静态站点 + 登录 / 账号 / 付费 + 受保护的双 Agent 协作接口
import express from "express";
import cookieParser from "cookie-parser";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { config, wechatOpenReady } from "./auth/config.ts";
import "./auth/db.ts";
import { attachBrowser, cleanupBrowsers } from "./auth/browser.ts";
import { attachUser, noStore, requireAuthApi, requireAccessApi, requireAccessPage } from "./auth/middleware.ts";
import { requireCsrf } from "./auth/security.ts";
import { auth, account } from "./auth/routes.ts";
import { cleanupTx } from "./auth/tx.ts";
import { billing, paymentWebhook } from "./billing/routes.ts";
import { admin, isAdmin } from "./billing/admin.ts";
import { device, cleanupDeviceCodes } from "./auth/device.ts";
import { localMode, local, isPaired, cachedUser, reportUsage, getCloudUrl } from "./auth/localmode.ts";
import { recordUsage } from "./billing/access.ts";
import { betaFree } from "./billing/settings.ts";
import { runCollaboration, type RunConfig, type Event } from "./orchestrator.ts";
import { loadMediaSettings, saveMediaSettings, publicMediaSettings, createMediaProvider, MEDIA_FILE_RE, mediaMime } from "./agents/media.ts";
import { detectAgents, getCachedAgent, startService, loginCommandFor, windowsProcessNames } from "./agents/detect.ts";
import { submitRelayReply, ignoreRelayText, sendToApp, listRunningApps, markOwnClipboardText, runInTerminal } from "./agents/relay.ts";
import { getProxyEnv } from "./agents/proxy.ts";
import { runFinalizer, VersionStore } from "./finalizer/service.ts";
import { makeAgent } from "./finalizer/agent.ts";
import { dockerAvailable } from "./finalizer/executor.ts";
import type { Version } from "./finalizer/types.ts";

const here = config.root;
const SESSIONS = process.env.SESSIONS_DIR || path.join(here, "sessions");
const HOST = process.env.HOST || (localMode ? "127.0.0.1" : "0.0.0.0");
const runs = new Map<string, AbortController>();
const liveRuns = new Map<string, number>();   // 进行中的协作 → 所属用户（session.json 写入前，媒体文件就要能看）
const DATA_DIR = path.dirname(config.dbPath);   // media.json（图片 / 视频生成的 API Key）与 app.db 同目录

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// 支付回调：在任何 body 解析之前注册，保留原始字节供验签
app.post("/api/payments/webhook", ...paymentWebhook);

app.use(cookieParser());
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(attachBrowser);
if (localMode) {
  // 桌面软件：用户来自与 peergrading.ai 配对后的缓存，不做本地登录
  app.use((req, _res, next) => { (req as any).user = cachedUser(); (req as any).session = null; next(); });
  app.use(["/api", "/app", "/pair"], noStore);
  app.use(local);
  app.get("/", (_req, res) => res.redirect(isPaired() ? "/app" : "/pair"));
  app.get("/pair", (_req, res) => res.sendFile(path.join(here, "views", "pair.html")));
  app.get("/app", (_req, res) => isPaired() ? res.sendFile(path.join(here, "views", "app.html")) : res.redirect("/pair"));
  app.get(["/account", "/account.html", "/login"], (_req, res) => res.redirect(`${getCloudUrl()}/account`));
} else {
  app.use(attachUser);
  app.use(["/api", "/auth", "/login", "/app", "/account", "/device", "/admin"], noStore);
  // 邀请链接 /?ref=码：先记在 Cookie 里，首次登录建号时登记邀请
  app.use((req, res, next) => {
    const ref = req.query.ref;
    if (req.method === "GET" && typeof ref === "string" && /^[A-Za-z0-9]{6,16}$/.test(ref)) res.cookie("pg_ref", ref.toUpperCase(), { maxAge: 30 * 86400 * 1000, httpOnly: true, sameSite: "lax", secure: config.isProd, path: "/" });
    next();
  });
  app.use(auth);
  app.use("/api/account", account);
  app.use(billing);
  app.use(device);
  /* ---------- 站主后台 ---------- */
  app.use(admin);
  app.get("/admin", (req, res) => {
    const u = (req as any).user;
    if (!u) return res.redirect("/login?return_to=%2Fadmin&reason=required");
    if (!isAdmin(u)) return res.status(404).type("text").send("Not found");
    res.sendFile(path.join(here, "views", "admin.html"));
  });
  // 后台上传的收款码 / 微信群二维码：只给已登录用户看（账号页、订单页、后台）
  app.use("/uploads", (req, res, next) => ((req as any).user ? next() : res.status(401).type("text").send("Unauthorized")), express.static(config.uploadsDir, { index: false, dotfiles: "deny", maxAge: "1h", setHeaders: (res) => res.set("Cache-Control", "private, max-age=3600") }));
  /* ---------- 软件下载 ---------- */
  const DOWNLOADS = process.env.DOWNLOADS_DIR || path.join(here, "downloads");
  app.use("/download", express.static(DOWNLOADS, { index: false, dotfiles: "deny" }));
  app.get("/api/download/latest", (_req, res) => {
    const files = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS).filter((f) => /\.(dmg|exe|zip|AppImage)$/i.test(f)) : [];
    const pick = (re: RegExp) => files.filter((f) => re.test(f)).map((f) => { const st = fs.statSync(path.join(DOWNLOADS, f)); const v = f.match(/(\d+\.\d+\.\d+)/)?.[1] ?? ""; return { file: f, url: `/download/${encodeURIComponent(f)}`, size: st.size, version: v, mtime: st.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime)[0] ?? null;
    res.json({ macArm: pick(/-arm64\.dmg$/i), macIntel: pick(/^(?!.*arm64).*\.dmg$/i), mac: pick(/-arm64\.dmg$/i) ?? pick(/\.dmg$/i), win: pick(/\.exe$/i) });
  });
  /* ---------- 网页版工作台（需登录 + 试用/会员；生产默认关闭） ---------- */
  app.get("/app", (req, res, next) => (config.webWorkspace ? next() : res.redirect("/#download")), requireAccessPage, (_req, res) => res.sendFile(path.join(here, "views", "app.html")));
  app.get(["/account", "/account.html"], (_req, res) => res.sendFile(path.join(here, "public", "account.html")));
  app.get(["/device", "/device.html"], (_req, res) => res.sendFile(path.join(here, "public", "device.html")));
}

/* ---------- 协作接口（全部需登录；开始协作需使用权） ---------- */
const api = express.Router();
api.use(requireAuthApi);

api.get("/agents", async (req, res) => res.json({ agents: await detectAgents(req.query.refresh === "1") }));
api.get("/apps", async (_req, res) => res.json({ apps: await listRunningApps() }));
api.post("/services/start", requireCsrf, async (req, res) => {
  const r = await startService(req.body?.service === "ollama" ? "ollama" : "lmstudio");
  res.status(r.ok ? 200 : 500).json(r);
});
api.post("/agents/login", requireCsrf, async (req, res) => {
  const cmd = await loginCommandFor(String(req.body?.id ?? ""));
  if (!cmd) return res.status(404).json({ ok: false, message: "no login command" });
  const r = await runInTerminal({ command: cmd.command, argv: cmd.argv, env: cmd.proxy ? getProxyEnv() : {} });
  res.status(r.ok ? 200 : 500).json({ ...r, note: cmd.note });
});
api.post("/relay/send", requireCsrf, async (req, res) => {
  const text = String(req.body?.text ?? "");
  if (req.body?.requestId) markOwnClipboardText(String(req.body.requestId), text);
  const app = req.body?.app ? String(req.body.app).slice(0, 80) : undefined;
  res.json(await sendToApp(text, app, app ? windowsProcessNames(app) : []));
});
api.post("/relay/reply", requireCsrf, (req, res) => res.status(submitRelayReply(String(req.body?.requestId ?? ""), String(req.body?.text ?? "")) ? 200 : 404).json({ ok: true }));
api.post("/relay/ignore", requireCsrf, (req, res) => res.json({ ok: ignoreRelayText(String(req.body?.requestId ?? ""), String(req.body?.text ?? "")) }));

api.get("/sessions", (req, res) => {
  const u = (req as any).user;
  const list = fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).filter((d) => {
    const f = path.join(SESSIONS, d, "session.json");
    if (!fs.existsSync(f)) return false;
    try {
      const fd = fs.openSync(f, "r"); const buf = Buffer.alloc(256); const n = fs.readSync(fd, buf, 0, 256, 0); fs.closeSync(fd);
      return new RegExp(`"userId":\\s*${u.id}\\b`).test(buf.subarray(0, n).toString("utf8"));   // session.json 以 {"id":…,"userId":…} 开头
    } catch { return false; }
  }).sort().reverse() : [];
  res.json(list);
});
api.get("/sessions/:id", (req, res) => {
  const u = (req as any).user;
  const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, "");
  const file = path.join(SESSIONS, id, "session.json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not_found" });
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.userId !== u.id) return res.status(404).json({ error: "not_found" });
  res.json(data);
});
api.post("/stop/:id", requireCsrf, (req, res) => { runs.get(String(req.params.id))?.abort(); res.json({ stopped: runs.has(String(req.params.id)) }); });

/* ---------- 图片 / 视频生成（OpenAI）：设置只存在本机 / 服务器的 data/media.json；桌面模式人人可改，云端仅管理员 ---------- */
const canEditMedia = (req: express.Request) => localMode || isAdmin((req as any).user);
api.get("/media/settings", (req, res) => res.json({ ...publicMediaSettings(loadMediaSettings(DATA_DIR)), canEdit: canEditMedia(req) }));
api.post("/media/settings", requireCsrf, (req, res) => {
  if (!canEditMedia(req)) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 500) : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const s = saveMediaSettings(DATA_DIR, { apiKey: str(b.apiKey), baseUrl: str(b.baseUrl), imageModel: str(b.imageModel), videoModel: str(b.videoModel), images: bool(b.images), videos: bool(b.videos) });
  res.json({ ok: true, ...publicMediaSettings(s), canEdit: true });
});
/** 协作中生成的图片 / 视频：只给会话所有者看 */
const sessionOwner = (id: string): number | null => {
  const f = path.join(SESSIONS, id, "session.json");
  try { const fd = fs.openSync(f, "r"); const buf = Buffer.alloc(256); const n = fs.readSync(fd, buf, 0, 256, 0); fs.closeSync(fd); const m = buf.subarray(0, n).toString("utf8").match(/"userId":\s*(\d+)/); return m ? Number(m[1]) : null; }
  catch { return null; }
};
api.get("/sessions/:id/media/:file", (req, res) => {
  const u = (req as any).user;
  const id = String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, ""), file = String(req.params.file);
  if (!id || !MEDIA_FILE_RE.test(file)) return res.status(404).json({ error: "not_found" });
  const owner = liveRuns.get(id) ?? sessionOwner(id);
  const f = path.join(SESSIONS, id, "media", file);
  if (owner !== u.id || !fs.existsSync(f)) return res.status(404).json({ error: "not_found" });
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.type(mediaMime(file)).sendFile(f);
});

async function buildConfig(raw: any, cwd: string): Promise<RunConfig> {
  const task = String(raw?.task ?? "").trim();
  if (!task) throw new Error("EMPTY_TASK");
  const lang = raw?.lang === "en" ? "en" : "zh";
  const agents = await detectAgents();
  const pick = (slot: any, fallbackName: string) => {
    const info = agents.find((a) => a.id === slot?.agentId) ?? getCachedAgent(slot?.agentId);
    if (!info) throw new Error("NO_AGENT");
    const runner = info.runner.type === "anthropic" && ["low", "medium", "high", "xhigh", "max"].includes(slot?.effort) ? { ...info.runner, effort: slot.effort } : info.runner;
    return { name: String(slot?.name || fallbackName).slice(0, 40), persona: String(slot?.persona ?? "").slice(0, 2000), agent: { ...info, runner } };
  };
  return { task, lang, cwd, agentA: pick(raw.agentA, "Agent A"), agentB: pick(raw.agentB, "Agent B"),
    maxRounds: Math.min(10, Math.max(1, Number(raw?.maxRounds) || 3)), discussionTurns: Math.min(3, Math.max(1, Number(raw?.discussionTurns) || 1)) };
}

api.post("/run", requireCsrf, requireAccessApi, async (req, res) => {
  const u = (req as any).user;
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(SESSIONS, id);
  const workspace = path.join(dir, "workspace");
  let cfg: RunConfig;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    cfg = await buildConfig(req.body, workspace);
  } catch (e: any) { return res.status(400).json({ error: e.message }); }
  if (localMode) {
    try { await reportUsage(id); }
    catch (e: any) { return res.status(e?.code === "payment_required" ? 403 : 401).json({ error: e?.code ?? "unauthenticated", access: e?.access }); }
  } else recordUsage(u, id);
  // 图片 / 视频生成：由界面勾选决定本次是否允许；未配置 API Key 时提示并照常协作
  const want = { images: !!req.body?.media?.images, videos: !!req.body?.media?.videos };
  let mediaNote = "";
  if (want.images || want.videos) {
    const ms = loadMediaSettings(DATA_DIR);
    const provider = await createMediaProvider(ms).catch(() => null);
    if (provider) cfg.media = { provider, dir: path.join(dir, "media"), images: want.images && ms.images, videos: want.videos && ms.videos };
    else mediaNote = cfg.lang === "zh" ? "未配置图片 / 视频生成的 API Key，本次协作不生成媒体。" : "No API key is configured for image / video generation; this run produces no media.";
  }
  const ac = new AbortController();
  runs.set(id, ac); liveRuns.set(id, u.id);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const events: Event[] = [];
  const send = (ev: Event) => { events.push(ev); res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  res.write(`data: ${JSON.stringify({ type: "run", id })}\n\n`);
  if (mediaNote) send({ type: "status", text: mediaNote });
  req.on("close", () => ac.abort());
  let result: Awaited<ReturnType<typeof runCollaboration>> | null = null;
  try { result = await runCollaboration(cfg, send, ac.signal); }
  catch (e: any) {
    if (ac.signal.aborted) send({ type: "status", text: cfg.lang === "zh" ? "已被用户停止。" : "Stopped by user." });
    else send({ type: "error", message: e?.message ?? String(e) });
  } finally {
    runs.delete(id);
    try {
      const strip = (c: any) => ({ ...c, agent: { ...c.agent, runner: undefined } });
      const versionIds = await saveVersions(id, dir, result);
      const { media: _m, ...cfgNoMedia } = cfg;   // provider 对象不进 session.json
      fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ id, userId: u.id, config: { ...cfgNoMedia, agentA: strip(cfg.agentA), agentB: strip(cfg.agentB), media: cfg.media ? { images: cfg.media.images, videos: cfg.media.videos } : undefined }, result, events, versionIds }, null, 2));
    } catch (e) { console.error("session save failed", e); }
    liveRuns.delete(id);
    res.end();
  }
});
/** 把一次协作的各版本冻结为 VersionStore 记录（JSON 为权威，Markdown 仅供查看） */
async function saveVersions(sessionId: string, dir: string, result: Awaited<ReturnType<typeof runCollaboration>> | null): Promise<Record<number, string>> {
  const ids: Record<number, string> = {};
  if (!result) return ids;
  const store = new VersionStore(dir);
  for (const v of result.versions) {
    const reviewStatus = v.n === result.finalVersion ? (result.approved ? "passed" : "unknown") : "not-passed";
    const saved = await store.save({ sessionId, round: v.n - 1, author: v.name, reviewStatus, content: v.content });
    ids[v.n] = saved.id;
  }
  return ids;
}
function loadOwnedSession(req: express.Request): { id: string; dir: string; data: any } | null {
  const u = (req as any).user;
  const id = String(req.params.id ?? req.body?.sessionId ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(SESSIONS, id);
  const file = path.join(dir, "session.json");
  if (!id || !fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.userId !== u.id) return null;
  return { id, dir, data };
}

api.get("/finalize/env", async (_req, res) => res.json({ docker: await dockerAvailable(), hostSupported: process.platform !== "win32", platform: process.platform }));

const finalizeRuns = new Map<string, AbortController>();
api.post("/finalize", requireCsrf, requireAccessApi, async (req, res) => {
  const owned = loadOwnedSession(req);
  if (!owned) return res.status(404).json({ error: "not_found" });
  const n = Number(req.body?.versionN);
  const versions = owned.data.result?.versions ?? [];
  const v = versions.find((x: any) => x.n === n);
  if (!v) return res.status(400).json({ error: "bad_version" });
  const info = getCachedAgent(String(req.body?.agentId ?? "")) ?? (await detectAgents()).find((a) => a.id === req.body?.agentId);
  if (!info || info.kind === "relay") return res.status(400).json({ error: "bad_agent" });
  // 旧会话可能没有 versionIds：按需冻结
  let versionIds: Record<number, string> = owned.data.versionIds ?? {};
  if (!versionIds[n]) {
    versionIds = await saveVersions(owned.id, owned.dir, owned.data.result);
    fs.writeFileSync(path.join(owned.dir, "session.json"), JSON.stringify({ ...owned.data, versionIds }, null, 2));
  }
  const store = new VersionStore(owned.dir);
  let version: Version;
  try { version = await store.get(versionIds[n]); } catch (e: any) { return res.status(400).json({ error: e?.message ?? "bad_version" }); }
  const sandbox = req.body?.sandbox === "host" ? "host" : "docker";
  const maxFixAttempts = Math.min(3, Math.max(0, Number(req.body?.maxFixAttempts) || 0));
  const runId = crypto.randomUUID();
  const ac = new AbortController();
  finalizeRuns.set(runId, ac);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (ev: any) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  send({ type: "run", runId, versionId: version.id });
  req.on("close", () => ac.abort());
  try {
    const result = await runFinalizer({
      task: owned.data.config.task, version, sessionDir: owned.dir,
      config: { enabled: true, sandbox, maxFixAttempts, pull: !!req.body?.pull, image: req.body?.image ? String(req.body.image) : undefined },
      agent: makeAgent(info, path.join(owned.dir, "workspace")), cancelSignal: ac.signal, runId,
      onEvent: (e) => send({ type: "event", stage: e.stage, message: e.message }),
    });
    const { attempts, ...summary } = result;
    send({ type: "result", result: { ...summary, attempts: attempts.map((a) => ({ index: a.index, status: a.status, summary: a.summary, checks: a.checks, results: a.results.map((r) => ({ commandId: r.commandId, stage: r.stage, argv: r.argv, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdout: r.stdout.slice(0, 4000), stderr: r.stderr.slice(0, 4000) })), agentVerdict: a.agentVerdict })), reportUrl: result.reportPath ? `/api/sessions/${owned.id}/finalizer/${runId}/report.md` : undefined } });
  } catch (e: any) {
    send({ type: "error", message: e?.message ?? String(e) });
  } finally { finalizeRuns.delete(runId); res.end(); }
});
api.post("/finalize/stop/:runId", requireCsrf, (req, res) => { finalizeRuns.get(String(req.params.runId))?.abort(); res.json({ ok: true }); });
api.get("/sessions/:id/finalizer/:runId/report.md", (req, res) => {
  const owned = loadOwnedSession(req);
  const runId = String(req.params.runId);
  if (!owned || !/^[a-f0-9-]{36}$/.test(runId)) return res.status(404).json({ error: "not_found" });
  const file = path.join(owned.dir, "finalizer", runId, "report.md");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not_found" });
  res.type("text/markdown; charset=utf-8").send(fs.readFileSync(file, "utf8"));
});

app.use("/api", api);

/* ---------- 静态文件：views/ 与 sessions/ 不在静态目录 ---------- */
app.use(express.static(path.join(here, "public"), { extensions: ["html"], index: "index.html" }));
app.use((req, res) => { if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not_found" }); res.status(404).type("text").send("Not found"); });
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({ at: "server", type: err?.constructor?.name, code: err?.code, msg: config.isProd ? undefined : String(err?.message).slice(0, 200) }));
  if (req.path.startsWith("/api/")) return res.status(500).json({ error: "server_error" });
  res.status(500).type("text").send("服务暂时不可用，请稍后重试");
});

setInterval(() => { cleanupTx(); cleanupBrowsers(); if (!localMode) cleanupDeviceCodes(); }, 10 * 60 * 1000).unref();
app.listen(config.port, HOST, () => {
  console.log(localMode ? `PeerGrading 桌面模式: http://${HOST}:${config.port}  (cloud=${getCloudUrl()}, paired=${isPaired()})`
    : `${config.plan.name}: ${config.baseUrl}  (devLogin=${config.devLogin}, google=${!!config.google.clientId}, wechat=${wechatOpenReady()}, beta=${betaFree()}, plan=${config.plan.mode === "days" ? config.plan.priceCents / 100 + " " + config.plan.currency + "/" + config.plan.days + "d" : "buyout"})`);
  detectAgents().then((a) => console.log(`已识别 ${a.length} 个 agent：` + a.map((x) => `${typeof x.title === "string" ? x.title : x.title.zh}[${x.status}]`).join(", ")));
});
