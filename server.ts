// server.ts — 仅监听本机回环地址的双 Agent 协作服务
import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { inspectRepository } from "./repository/workspace.ts";
import { parseCheckCommands } from "./workspace-input.ts";
import { config, LOCAL_HOST } from "./runtime-config.ts";
import { localCsrf, requireCsrf, requireLocalHost } from "./local-security.ts";
import { runCollaboration, type RunConfig, type Event } from "./orchestrator.ts";
import { SessionStore, listSessions, readSession } from "./session-store.ts";
import { loadMediaSettings, saveMediaSettings, publicMediaSettings, createMediaProvider, MEDIA_FILE_RE, mediaMime } from "./agents/media.ts";
import { detectAgents, getCachedAgent, invalidateAgentCache, startService, loginCommandFor, windowsProcessNames } from "./agents/detect.ts";
import { createLocalConnectionsRouter, publicAgentInfo } from "./agents/local-connections-routes.ts";
import { createApiConnectionsRouter } from "./agents/api-connections-routes.ts";
import { submitRelayReply, ignoreRelayText, sendToApp, listRunningApps, markOwnClipboardText, runInTerminal } from "./agents/relay.ts";
import { getProxyEnv } from "./agents/proxy.ts";
import { runFinalizer, VersionStore } from "./finalizer/service.ts";
import { makeAgent } from "./finalizer/agent.ts";
import { dockerAvailable } from "./finalizer/executor.ts";
import type { Version } from "./finalizer/types.ts";

const here = config.root;
const SESSIONS = config.sessionsDir;
const DATA_DIR = config.dataDir;
const runs = new Map<string, AbortController>();
const finalizeRuns = new Map<string, AbortController>();
const liveRuns = new Set<string>();

const app = express();
app.disable("x-powered-by");
app.use(requireLocalHost);
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(["/api", "/app"], (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.get("/", (_req, res) => res.redirect("/app"));
app.get("/app", (_req, res) => res.sendFile(path.join(here, "views", "app.html")));

const api = express.Router();
api.get("/bootstrap", (_req, res) => res.json({ csrf: localCsrf(), localMode: true, repositoryAvailable: true }));
api.use(createLocalConnectionsRouter({ directory: DATA_DIR, available: true, requireCsrf, onChanged: invalidateAgentCache }));
api.use(createApiConnectionsRouter({ directory: DATA_DIR, available: true, requireCsrf, onChanged: invalidateAgentCache }));

api.get("/repositories/status", (_req, res) => res.json({ available: true }));
api.post("/repositories/inspect", requireCsrf, async (req, res) => {
  try { res.json({ repository: await inspectRepository(String(req.body?.path || "")) }); }
  catch (e: any) { res.status(400).json({ error: e?.message || "invalid_repository" }); }
});
function loadRepositorySession(req: express.Request): { dir: string } | null {
  const id = String(req.params.id || "");
  if (id && liveRuns.has(id)) return { dir: path.join(SESSIONS, id) };
  return loadLocalSession(req);
}
api.get("/sessions/:id/repository", (req, res) => {
  const owned = loadRepositorySession(req);
  if (!owned) return res.status(404).json({ error: "not_found" });
  try { res.json({ repository: JSON.parse(fs.readFileSync(path.join(owned.dir, "repository", "manifest.json"), "utf8")) }); }
  catch { res.status(404).json({ error: "not_found" }); }
});
api.get("/sessions/:id/repository/versions/:n.patch", (req, res) => {
  const owned = loadRepositorySession(req);
  const n = String(req.params.n);
  if (!owned || !/^[1-9]\d{0,2}$/.test(n)) return res.status(404).json({ error: "not_found" });
  const file = path.join(owned.dir, "repository", `v${n}.patch`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not_found" });
  res.type("text/x-diff").sendFile(file);
});

api.get("/agents", async (req, res) => res.json({ agents: (await detectAgents(req.query.refresh === "1")).map(publicAgentInfo) }));
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

api.get("/sessions", (_req, res) => {
  res.json(listSessions(SESSIONS));
});
api.get("/sessions/:id", (req, res) => {
  const id = String(req.params.id);
  try {
    const data = readSession(SESSIONS, id, runs.has(id));
    if (!data) return res.status(404).json({ error: "not_found" });
    res.json(data);
  } catch { res.status(500).json({ error: "session_corrupt" }); }
});
api.post("/stop/:id", requireCsrf, (req, res) => {
  const id = String(req.params.id);
  try {
    if (!liveRuns.has(id) && !readSession(SESSIONS, id, runs.has(id))) return res.status(404).json({ error: "not_found" });
    const controller = runs.get(id); controller?.abort(); res.json({ stopped: !!controller });
  } catch { res.status(500).json({ error: "session_corrupt" }); }
});

api.get("/media/settings", (_req, res) => {
  const s = loadMediaSettings(DATA_DIR);
  res.json({ ...publicMediaSettings(s), canEdit: true });
});
api.post("/media/settings", requireCsrf, (req, res) => {
  const b = req.body || {};
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 500) : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  const s = saveMediaSettings(DATA_DIR, { apiKey: str(b.apiKey), baseUrl: str(b.baseUrl), imageModel: str(b.imageModel), videoModel: str(b.videoModel), images: bool(b.images), videos: bool(b.videos) });
  res.json({ ok: true, ...publicMediaSettings(s), canEdit: true });
});
api.get("/sessions/:id/media/:file", (req, res) => {
  const id = String(req.params.id), file = String(req.params.file);
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id) || !MEDIA_FILE_RE.test(file)) return res.status(404).json({ error: "not_found" });
  const f = path.join(SESSIONS, id, "media", file);
  if ((!liveRuns.has(id) && !fs.existsSync(path.join(SESSIONS, id, "session.json"))) || !fs.existsSync(f)) return res.status(404).json({ error: "not_found" });
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.type(mediaMime(file)).sendFile(f);
});

async function buildConfig(raw: any, cwd: string, sessionDir: string): Promise<RunConfig> {
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
  const agentA = pick(raw.agentA, "Agent A"), agentB = pick(raw.agentB, "Agent B");
  let repository: RunConfig["repository"];
  if (raw?.mode === "repository") {
    if (![agentA, agentB].every((a) => ["claude-code", "codex", "kimi-code"].includes(a.agent.runner.type))) throw new Error("repository_agents_required");
    const info = await inspectRepository(String(raw.repository?.path || ""));
    if (info.dirty) throw new Error("repository_dirty");
    repository = { path: info.path, sessionDir, checks: parseCheckCommands(raw.repository?.testCommands) };
  }
  const acceleration = {
    speculativeReview: raw?.acceleration?.speculativeReview === true,
    cache: raw?.acceleration?.cache === true,
  };
  return { task, lang, cwd, repository, agentA, agentB,
    ...(acceleration.speculativeReview || acceleration.cache ? { acceleration } : {}),
    maxRounds: Math.min(10, Math.max(1, Number(raw?.maxRounds) || 3)), discussionTurns: Math.min(3, Math.max(1, Number(raw?.discussionTurns) || 1)) };
}

api.post("/run", requireCsrf, async (req, res) => {
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(3).toString("hex");
  const dir = path.join(SESSIONS, id);
  const workspace = path.join(dir, "workspace");
  const ac = new AbortController();
  runs.set(id, ac);
  res.once("close", () => { if (!res.writableEnded) ac.abort(); });
  const cancelled = () => ac.signal.aborted || res.destroyed;
  let cfg: RunConfig;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    cfg = await buildConfig(req.body, workspace, dir);
  } catch (e: any) { runs.delete(id); if (cancelled()) return res.end(); return res.status(400).json({ error: e.message }); }
  if (cancelled()) { runs.delete(id); return res.end(); }
  const want = { images: !cfg.repository && !!req.body?.media?.images, videos: !cfg.repository && !!req.body?.media?.videos };
  let mediaNote = "";
  if (want.images || want.videos) {
    const ms = loadMediaSettings(DATA_DIR);
    const provider = await createMediaProvider(ms).catch(() => null);
    if (provider) cfg.media = { provider, dir: path.join(dir, "media"), images: want.images && ms.images, videos: want.videos && ms.videos };
    else mediaNote = cfg.lang === "zh" ? "未配置图片 / 视频生成的 API Key，本次协作不生成媒体。" : "No API key is configured for image / video generation; this run produces no media.";
  }
  if (cancelled()) { runs.delete(id); return res.end(); }
  let session: SessionStore;
  try { session = new SessionStore(SESSIONS, id, cfg); }
  catch (e) { runs.delete(id); console.error("session initialization failed", e); return res.status(500).json({ error: "session_save_failed" }); }
  liveRuns.add(id);
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  let persistenceError: Error | null = null;
  const send = (ev: Event) => {
    if (persistenceError) return;
    try { session.append(ev); }
    catch (e) {
      // CLI stdout invokes this callback from a Node event listener; throwing
      // here would crash the whole server instead of rejecting the Agent turn.
      persistenceError = e instanceof Error ? e : new Error(String(e)); ac.abort(); return;
    }
    if (!res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  res.write(`data: ${JSON.stringify({ type: "run", id })}\n\n`);
  let result: Awaited<ReturnType<typeof runCollaboration>> | null = null;
  let status: "completed" | "cancelled" | "failed" = "completed";
  try {
    if (mediaNote) send({ type: "status", text: mediaNote });
    result = await runCollaboration(cfg, send, ac.signal);
    if (persistenceError) { result = null; throw persistenceError; }
  }
  catch (e: any) {
    status = !persistenceError && ac.signal.aborted ? "cancelled" : "failed";
    const failure = persistenceError ?? e;
    const event: Event = status === "cancelled" ? { type: "status", text: cfg.lang === "zh" ? "已被用户停止。" : "Stopped by user." } : { type: "error", message: String(failure?.message ?? failure).slice(0, 2000) };
    try {
      session.append(event);
      if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    catch (saveError) {
      console.error("session event save failed", saveError);
      if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } finally {
    let versionIds: Record<number, string> = {};
    try { versionIds = await saveVersions(id, dir, result ?? session.partialResult()); }
    catch (e) { console.error("session version save failed", e); }
    try { session.finish(status, result, versionIds); }
    catch (e) { console.error("session save failed", e); }
    runs.delete(id);
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
function loadLocalSession(req: express.Request): { id: string; dir: string; data: any } | null {
  const id = String(req.params.id ?? req.body?.sessionId ?? "");
  const dir = path.join(SESSIONS, id);
  try {
    const data = readSession(SESSIONS, id, runs.has(id));
    return data ? { id, dir, data } : null;
  } catch { return null; }
}

api.get("/finalize/env", async (_req, res) => res.json({ docker: await dockerAvailable(), hostSupported: process.platform !== "win32", platform: process.platform }));

api.post("/finalize", requireCsrf, async (req, res) => {
  const owned = loadLocalSession(req);
  if (!owned) return res.status(404).json({ error: "not_found" });
  if (owned.data.config?.repository) return res.status(400).json({ error: "repository_uses_checks" });
  const n = Number(req.body?.versionN);
  const versions = owned.data.result?.versions ?? [];
  const v = versions.find((x: any) => x.n === n);
  if (!v) return res.status(400).json({ error: "bad_version" });
  const runId = crypto.randomUUID(), ac = new AbortController();
  finalizeRuns.set(runId, ac);
  res.once("close", () => { if (!res.writableEnded) ac.abort(); finalizeRuns.delete(runId); });
  const cancelled = () => ac.signal.aborted || res.destroyed;
  const info = getCachedAgent(String(req.body?.agentId ?? "")) ?? (await detectAgents()).find((a) => a.id === req.body?.agentId);
  if (cancelled()) { finalizeRuns.delete(runId); return res.end(); }
  if (!info || info.kind === "relay") { finalizeRuns.delete(runId); return res.status(400).json({ error: "bad_agent" }); }
  // 旧会话可能没有 versionIds：按需冻结
  let versionIds: Record<number, string> = owned.data.versionIds ?? {};
  if (!versionIds[n]) {
    versionIds = await saveVersions(owned.id, owned.dir, owned.data.result);
    fs.writeFileSync(path.join(owned.dir, "session.json"), JSON.stringify({ ...owned.data, versionIds }, null, 2));
  }
  const store = new VersionStore(owned.dir);
  let version: Version;
  try { version = await store.get(versionIds[n]); } catch (e: any) { finalizeRuns.delete(runId); if (cancelled()) return res.end(); return res.status(400).json({ error: e?.message ?? "bad_version" }); }
  if (cancelled()) { finalizeRuns.delete(runId); return res.end(); }
  const sandbox = req.body?.sandbox === "host" ? "host" : "docker";
  const maxFixAttempts = Math.min(3, Math.max(0, Number(req.body?.maxFixAttempts) || 0));
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (ev: any) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  send({ type: "run", runId, versionId: version.id });
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
  const owned = loadLocalSession(req);
  const runId = String(req.params.runId);
  if (!owned || !/^[a-f0-9-]{36}$/.test(runId)) return res.status(404).json({ error: "not_found" });
  const file = path.join(owned.dir, "finalizer", runId, "report.md");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not_found" });
  res.type("text/markdown; charset=utf-8").send(fs.readFileSync(file, "utf8"));
});

app.use("/api", api);

/* ---------- 静态文件：views/ 与 sessions/ 不在静态目录 ---------- */
app.use(express.static(path.join(here, "public"), { extensions: ["html"], index: false }));
app.use((req, res) => { if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not_found" }); res.status(404).type("text").send("Not found"); });
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({ at: "server", type: err?.constructor?.name, code: err?.code, msg: config.isProd ? undefined : String(err?.message).slice(0, 200) }));
  if (req.path.startsWith("/api/")) return res.status(500).json({ error: "server_error" });
  res.status(500).type("text").send("服务暂时不可用，请稍后重试");
});

app.listen(config.port, LOCAL_HOST, () => {
  console.log(`PeerGrading 本地服务: http://${LOCAL_HOST}:${config.port}`);
  detectAgents().then((a) => console.log(`已识别 ${a.length} 个 agent：` + a.map((x) => `${typeof x.title === "string" ? x.title : x.title.zh}[${x.status}]`).join(", ")));
});
