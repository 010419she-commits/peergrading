// Desktop account: system-browser authorization, local device-token storage and a narrow cloud API proxy.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Router, type Request } from "express";
import { config } from "./config.ts";
import { ensureBrowser } from "./browser.ts";
import { issueCsrf, requireCsrf, randomToken, timingEq } from "./security.ts";
import { requireBrowser } from "./middleware.ts";
import { desktopReturnUrl } from "./desktop-return.ts";

export const localMode = process.env.LOCAL_MODE === "1";
const dataDir = path.dirname(config.dbPath);
const stateFile = path.join(dataDir, "device.json");
const cloudFile = path.join(dataDir, "cloud.json");
function validCloudUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    const encryptedOrLocal = url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    return encryptedOrLocal && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}
const DEFAULT_CLOUD = validCloudUrl(process.env.CLOUD_URL || "https://peergrading.ai") || "https://peergrading.ai";
let cloudOverride: string | null = (() => { try { return validCloudUrl(JSON.parse(fs.readFileSync(cloudFile, "utf8")).url); } catch { return null; } })();
let authGeneration = 0;
export const getCloudUrl = () => cloudOverride || DEFAULT_CLOUD;
function writePrivate(file: string, value: unknown) {
  const temporary = `${file}.${randomToken(6)}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}
export function setCloudUrl(url: string | null) {
  const normalized = url ? validCloudUrl(url) : null;
  if (url && !normalized) throw new Error("invalid_cloud_url");
  cloudOverride = normalized;
  authGeneration++;
  if (cloudOverride) writePrivate(cloudFile, { url: cloudOverride }); else try { fs.unlinkSync(cloudFile); } catch {}
}
const REFRESH_MS = 10 * 60 * 1000;
const OFFLINE_GRACE_MS = 72 * 3600 * 1000;

interface State { token: string; user: any; plan?: any; fetchedAt: number; deviceName: string; cloudUrl?: string }
let state: State | null = (() => {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return /^[A-Za-z0-9_-]{43}$/.test(saved.token) && saved.user?.id && Number.isFinite(saved.fetchedAt) && (!saved.cloudUrl || saved.cloudUrl === getCloudUrl()) ? saved : null;
  } catch { return null; }
})();
interface Pending { deviceCode: string; userCode: string; verificationUrl: string; expiresAt: number; state?: string; nextPollAt: number }
type PairStatus = "none" | "pending" | "approved" | "expired" | "denied" | "consumed" | "error";
let pending: Pending | null = null;
let completedCallback: { state: string; expiresAt: number; status: PairStatus } | null = null;
let lastStatus: PairStatus = "none", lastError = "";
let polling: Promise<PairStatus> | null = null;
let starting: Promise<any> | null = null;
const save = () => { if (state) writePrivate(stateFile, state); else try { fs.unlinkSync(stateFile); } catch {} };
const deviceName = () => `${os.hostname()} (${os.platform() === "darwin" ? "macOS" : os.platform()})`;

async function cloud(pathname: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(getCloudUrl() + pathname, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) }, redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch (error: any) {
    throw new Error(`无法连接账号服务 ${getCloudUrl()}（${error?.cause?.code || error?.name || "网络错误"}），请检查网络后重试。`);
  }
  const body: any = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}
export const isPaired = () => !!state?.token;
const pairingView = () => ({
  status: isPaired() ? "approved" : pending ? "pending" : lastStatus,
  paired: isPaired(), userCode: pending?.userCode ?? null, verificationUrl: pending?.verificationUrl ?? null,
  expiresAt: pending?.expiresAt ?? null, lastError,
});

/** A blank argument preserves the older manual 8-character pairing API. */
export async function startPairing(callback?: string) {
  if (starting) return starting;
  const generation = ++authGeneration;
  starting = (async () => {
    const authState = callback ? randomToken(32) : undefined;
    const response = await cloud("/api/device/start", { method: "POST", body: JSON.stringify({ deviceName: deviceName(), ...(callback ? { loopbackReturnUrl: callback, state: authState } : {}) }) });
    if (authGeneration !== generation) throw new Error("登录请求已取消，请重新登录");
    if (!response.ok) throw new Error(response.status === 429 ? "登录请求过于频繁，请稍后重试" : `账号服务返回 ${response.status}：${response.body?.error || "不可用"}`);
    const body = response.body;
    const verificationUrl = new URL(String(body.verificationUrl));
    if (!/^[A-Za-z0-9_-]{43}$/.test(body.deviceCode) || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(body.userCode) || !Number.isFinite(body.expiresIn) || body.expiresIn <= 0 || body.expiresIn > 600 || verificationUrl.origin !== getCloudUrl() || verificationUrl.pathname !== "/device") throw new Error("账号服务返回了无效的登录请求");
    pending = { deviceCode: body.deviceCode, userCode: body.userCode, verificationUrl: verificationUrl.href, expiresAt: Date.now() + body.expiresIn * 1000, state: authState, nextPollAt: 0 };
    completedCallback = null; lastStatus = "pending"; lastError = "";
    return { userCode: pending.userCode, verificationUrl: pending.verificationUrl, expiresAt: pending.expiresAt };
  })();
  try { return await starting; } finally { starting = null; }
}

export async function pollPairing(force = false): Promise<PairStatus> {
  if (!pending) return isPaired() ? "approved" : lastStatus;
  if (polling) return polling;
  const request = pending;
  if (Date.now() >= request.expiresAt) {
    if (request.state) completedCallback = { state: request.state, expiresAt: Date.now() + 60_000, status: "expired" };
    pending = null; return lastStatus = "expired";
  }
  if (!force && Date.now() < request.nextPollAt) return "pending";
  request.nextPollAt = Date.now() + 3000;
  polling = (async (): Promise<PairStatus> => {
    try {
      const response = await cloud("/api/device/poll", { method: "POST", body: JSON.stringify({ deviceCode: request.deviceCode }) });
      if (pending !== request) return isPaired() ? "approved" : lastStatus;
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) { lastError = "账号服务暂时繁忙，正在等待登录确认"; return "pending"; }
        pending = null; lastError = "登录请求已失效，请重新登录"; return lastStatus = "error";
      }
      if (response.body.status === "approved") {
        if (!/^[A-Za-z0-9_-]{43}$/.test(response.body.deviceToken) || !response.body.user?.id) {
          pending = null; lastError = "账号服务返回了无效的登录结果"; return lastStatus = "error";
        }
        state = { token: response.body.deviceToken, user: response.body.user, plan: response.body.plan, fetchedAt: Date.now(), deviceName: deviceName(), cloudUrl: getCloudUrl() };
        save();
        if (request.state) completedCallback = { state: request.state, expiresAt: request.expiresAt, status: "approved" };
        pending = null; lastError = ""; lastStatus = "approved";
        process.emit("peergrading:auth-complete" as any);
        return "approved";
      }
      if (["expired", "denied", "consumed"].includes(response.body.status)) {
        if (request.state) completedCallback = { state: request.state, expiresAt: Date.now() + 60_000, status: response.body.status };
        pending = null; return lastStatus = response.body.status;
      }
      if (response.body.status !== "pending") { pending = null; lastError = "登录状态无效，请重新登录"; return lastStatus = "error"; }
      return "pending";
    } catch (error: any) { lastError = String(error?.message || "暂时无法连接账号服务"); return "pending"; }
  })();
  try { return await polling; } finally { polling = null; }
}
export function unpair() {
  const wasPaired = !!state;
  authGeneration++; state = null; pending = null; completedCallback = null; lastStatus = "none"; save();
  if (wasPaired) process.emit("peergrading:auth-logout" as any);
}

/** Recheck the account online; a cached account remains usable for up to 72 hours offline. */
export async function refreshMe(force = false): Promise<void> {
  if (!state || (!force && Date.now() - state.fetchedAt < REFRESH_MS)) return;
  const requestState = state;
  try {
    const response = await cloud("/api/device/me", { headers: { authorization: `Bearer ${requestState.token}` } });
    if (state !== requestState) return;
    if (response.status === 401) { unpair(); lastError = "登录已失效或账号不可用，请重新登录"; return; }
    if (response.ok && response.body.user?.id === requestState.user.id) {
      state.user = response.body.user; state.plan = response.body.plan; state.fetchedAt = Date.now(); save(); lastError = "";
    } else lastError = "暂时无法核对会员状态，请稍后重试";
  } catch (error: any) { lastError = String(error?.message || "暂时无法连接账号服务"); }
}
export function cachedUser(): any | null {
  if (!state?.user || Date.now() - state.fetchedAt > OFFLINE_GRACE_MS) return null;
  const user = state.user;
  return { id: user.id, display_name: user.name, avatar_url: user.avatar, created_at: user.createdAt, status: "active", access: user.access, entitlements: user.entitlements };
}
export async function reportUsage(ref: string, expectedUserId?: number) {
  if (!state || (expectedUserId != null && state.user.id !== expectedUserId)) throw Object.assign(new Error("unauthenticated"), { code: "unauthenticated" });
  const requestState = state;
  try {
    const response = await cloud("/api/device/usage", { method: "POST", headers: { authorization: `Bearer ${state.token}` }, body: JSON.stringify({ ref }) });
    if (state !== requestState) throw Object.assign(new Error("unauthenticated"), { code: "unauthenticated" });
    if (response.status === 401) { if (state === requestState) unpair(); throw Object.assign(new Error("unauthenticated"), { code: "unauthenticated" }); }
    if (response.status === 403) throw Object.assign(new Error("payment_required"), { code: "payment_required", access: response.body.access });
    if (!response.ok || !response.body.access) throw new Error("account_service_unavailable");
    if (state === requestState) { state.user.access = response.body.access; state.fetchedAt = Date.now(); save(); }
    return response.body.access;
  } catch (error: any) {
    if (state !== requestState) throw Object.assign(new Error("unauthenticated"), { code: "unauthenticated" });
    if (error?.code) throw error;
    const user = cachedUser();
    if (!user) throw Object.assign(new Error("offline"), { code: "unauthenticated" });
    if (!user.access?.allowed) throw Object.assign(new Error("payment_required"), { code: "payment_required", access: user.access });
    return user.access;
  }
}

export const local = Router();
local.get("/api/auth/bootstrap", async (req, res) => {
  const request = req as any;
  ensureBrowser(req, res);
  await refreshMe();
  const user = cachedUser();
  res.json({
    status: user ? "authenticated" : "anonymous", localMode: true, cloudUrl: getCloudUrl(), cloudDefault: DEFAULT_CLOUD,
    paired: isPaired(), lastError, pairing: pairingView(),
    user: user ? { id: user.id, name: user.display_name, avatar: user.avatar_url, createdAt: user.created_at, access: user.access, entitlements: user.entitlements } : null,
    providers: {}, plan: state?.plan ?? null,
    csrf: issueCsrf({ bidHash: request.bidHash, sessionId: null, authEpoch: request.authEpoch }),
  });
});
function callbackFor(req: Request) {
  const callback = desktopReturnUrl(`http://127.0.0.1:${req.socket.localPort}/api/local/auth/callback`);
  if (!callback) throw new Error("invalid_local_port");
  return callback;
}
local.post(["/api/local/auth/start", "/api/local/pair/start"], requireBrowser, requireCsrf, async (req, res) => {
  if (isPaired()) return res.status(409).json({ error: "already_authenticated" });
  try { res.json(await startPairing(req.path === "/api/local/auth/start" ? callbackFor(req) : undefined)); }
  catch (error: any) { lastError = String(error?.message || "无法发起登录"); res.status(502).json({ error: lastError }); }
});
local.get(["/api/local/auth/status", "/api/local/pair/status"], requireBrowser, async (_req, res) => {
  await pollPairing(); res.json(pairingView());
});
function callbackPage(res: any, approved: boolean, status: string) {
  const message = approved ? "已登录，请返回 PeerGrading 软件，可以关闭此页。" : status === "denied" ? "已取消登录，请返回 PeerGrading 软件。" : status === "expired" ? "登录请求已过期，请返回 PeerGrading 软件重新登录。" : "暂未完成登录，请返回 PeerGrading 软件查看状态或重试。";
  return res.type("html").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PeerGrading 登录</title></head><body style="background:#141518;color:#eee;font:18px system-ui;padding:12vh 8vw"><h1>PeerGrading</h1><p>${message}</p></body></html>`);
}
local.get("/api/local/auth/callback", async (req, res) => {
  res.set("Referrer-Policy", "no-referrer");
  const supplied = req.query.state;
  if (typeof supplied !== "string" || !pending?.state || !timingEq(supplied, pending.state)) {
    if (typeof supplied === "string" && completedCallback && completedCallback.expiresAt > Date.now() && timingEq(supplied, completedCallback.state)) return callbackPage(res, completedCallback.status === "approved" && isPaired(), completedCallback.status);
    return res.status(400).type("text").send("登录请求无效，请回到 PeerGrading 软件重新登录。");
  }
  let status = await pollPairing(true);
  if (status === "pending") status = await pollPairing(true);
  return callbackPage(res, status === "approved", status);
});
local.post(["/api/local/auth/logout", "/api/local/unpair"], requireBrowser, requireCsrf, async (_req, res) => {
  const token = state?.token;
  unpair(); lastError = "";
  if (!token) process.emit("peergrading:auth-logout" as any);
  if (token) try { await cloud("/api/device/logout", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" }); } catch {}
  res.json({ ok: true });
});
local.post("/api/local/cloud", requireBrowser, requireCsrf, (req, res) => {
  if (isPaired()) return res.status(409).json({ error: "paired" });
  try { setCloudUrl(req.body?.url ? String(req.body.url) : null); }
  catch { return res.status(400).json({ error: "invalid_cloud_url" }); }
  pending = null; completedCallback = null; lastStatus = "none"; lastError = "";
  res.json({ ok: true, cloudUrl: getCloudUrl() });
});

// Device tokens stay in the backend. There is deliberately no arbitrary URL, path or OAuth proxy.
const accountGet = /^\/(?:orders\/[A-Za-z0-9]{8,64}|referral|devices)\/?$/;
const accountPost = /^\/(?:orders|orders\/[A-Za-z0-9]{8,64}\/(?:checkout|sync)|referral\/claim|devices\/revoke)\/?$/;
local.use("/api/local/account", requireBrowser, (req, res, next) => {
  const allowed = req.method === "GET" ? req.path === "/" || accountGet.test(req.path) : req.method === "POST" && accountPost.test(req.path);
  if (!allowed) return res.status(404).json({ error: "not_found" });
  if (req.method === "POST") return requireCsrf(req, res, next);
  next();
}, async (req, res) => {
  if (!state) return res.status(401).json({ error: "unauthenticated" });
  const requestState = state;
  try {
    const suffix = req.path === "/" ? "" : req.path.replace(/\/$/, "");
    const response = await cloud(`/api/desktop/account${suffix}`, { method: req.method, headers: { authorization: `Bearer ${requestState.token}` }, ...(req.method === "POST" ? { body: JSON.stringify(req.body || {}) } : {}) });
    if (state !== requestState) return res.status(409).json({ error: "account_changed" });
    if (response.status === 401) { unpair(); lastError = "登录已失效，请重新登录"; }
    if (response.ok && suffix === "/devices/revoke" && response.body.current === true && state === requestState) {
      unpair();
    }
    if (state === requestState && response.ok) {
      const body = response.body;
      if (body.user?.id === requestState.user.id) state.user = body.user;
      if (body.access) state.user.access = body.access;
      if (body.plan) state.plan = body.plan;
      if (body.user || body.access) { state.fetchedAt = Date.now(); save(); }
    }
    res.status(response.status).json(response.body);
  } catch (error: any) { res.status(502).json({ error: String(error?.message || "账号服务暂时不可用") }); }
});
