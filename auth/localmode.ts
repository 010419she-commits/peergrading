// auth/localmode.ts — 桌面软件模式：本机不做登录，而是与 peergrading.ai 配对，用设备令牌核对使用权
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Router } from "express";
import { config } from "./config.ts";
import { ensureBrowser } from "./browser.ts";
import { issueCsrf, requireCsrf } from "./security.ts";
import { requireBrowser } from "./middleware.ts";

export const localMode = process.env.LOCAL_MODE === "1";
export const cloudUrl = (process.env.CLOUD_URL || "https://peergrading.ai").replace(/\/$/, "");
const stateFile = path.join(path.dirname(config.dbPath), "device.json");
const REFRESH_MS = 10 * 60 * 1000;
const OFFLINE_GRACE_MS = 72 * 3600 * 1000;

interface State { token: string; user: any; plan?: any; fetchedAt: number; deviceName: string }
let state: State | null = (() => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; } })();
let pending: { deviceCode: string; userCode: string; verificationUrl: string; expiresAt: number } | null = null;
let lastError = "";
const save = () => { if (state) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 }); else try { fs.unlinkSync(stateFile); } catch {} };
const deviceName = () => `${os.hostname()} (${os.platform() === "darwin" ? "macOS" : os.platform()})`;

async function cloud(pathname: string, init: RequestInit = {}) {
  const r = await fetch(cloudUrl + pathname, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
  const body: any = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

export const isPaired = () => !!state?.token;

export async function startPairing() {
  const r = await cloud("/api/device/start", { method: "POST", body: JSON.stringify({ deviceName: deviceName() }) });
  if (!r.ok) throw new Error(`云端不可用（${r.status}）`);
  pending = { deviceCode: r.body.deviceCode, userCode: r.body.userCode, verificationUrl: r.body.verificationUrl, expiresAt: Date.now() + r.body.expiresIn * 1000 };
  return { userCode: pending.userCode, verificationUrl: pending.verificationUrl };
}
export async function pollPairing(): Promise<"none" | "pending" | "approved" | "expired" | "denied"> {
  if (!pending) return "none";
  if (Date.now() > pending.expiresAt) { pending = null; return "expired"; }
  const r = await cloud("/api/device/poll", { method: "POST", body: JSON.stringify({ deviceCode: pending.deviceCode }) });
  if (!r.ok) return "pending";
  if (r.body.status === "approved") {
    state = { token: r.body.deviceToken, user: r.body.user, fetchedAt: Date.now(), deviceName: deviceName() };
    save(); pending = null; return "approved";
  }
  if (r.body.status === "expired" || r.body.status === "denied") { pending = null; return r.body.status; }
  return "pending";
}
export function unpair() { state = null; pending = null; save(); }

/** 向云端刷新用户与使用权；离线时沿用 72 小时内的缓存 */
export async function refreshMe(force = false): Promise<void> {
  if (!state) return;
  if (!force && Date.now() - state.fetchedAt < REFRESH_MS) return;
  try {
    const r = await cloud("/api/device/me", { headers: { authorization: `Bearer ${state.token}` } });
    if (r.status === 401) { unpair(); lastError = "设备已被断开或账号不可用，请重新配对"; return; }
    if (r.ok) { state.user = r.body.user; state.plan = r.body.plan; state.fetchedAt = Date.now(); save(); lastError = ""; }
  } catch (e: any) { lastError = `无法连接 ${cloudUrl}：${e?.message ?? e}`; }
}
/** 供中间件使用的用户对象（与云端 users 行形状兼容） */
export function cachedUser(): any | null {
  if (!state?.user) return null;
  if (Date.now() - state.fetchedAt > OFFLINE_GRACE_MS) return null;
  const u = state.user;
  return { id: u.id, display_name: u.name, avatar_url: u.avatar, created_at: u.createdAt, status: "active", access: u.access, entitlements: u.entitlements };
}
/** 开始一次协作：向云端记一次试用用量并取回最新使用权；云端拒绝时抛出 { code: "payment_required", access } */
export async function reportUsage(ref: string) {
  if (!state) throw Object.assign(new Error("unpaired"), { code: "unauthenticated" });
  try {
    const r = await cloud("/api/device/usage", { method: "POST", headers: { authorization: `Bearer ${state.token}` }, body: JSON.stringify({ ref }) });
    if (r.status === 401) { unpair(); throw Object.assign(new Error("unpaired"), { code: "unauthenticated" }); }
    if (r.status === 403) throw Object.assign(new Error("payment_required"), { code: "payment_required", access: r.body.access });
    if (r.ok && r.body.access && state.user) { state.user.access = r.body.access; state.fetchedAt = Date.now(); save(); }
    return r.body.access;
  } catch (e: any) {
    if (e?.code) throw e;
    // 离线：用缓存判断；仍允许在宽限期内使用
    const u = cachedUser();
    if (!u) throw Object.assign(new Error("offline"), { code: "unauthenticated" });
    if (!u.access?.allowed) throw Object.assign(new Error("payment_required"), { code: "payment_required", access: u.access });
    return u.access;
  }
}

/* ---------- 本机模式的路由：bootstrap / 配对 ---------- */
export const local = Router();
local.get("/api/auth/bootstrap", async (req, res) => {
  const r = req as any;
  ensureBrowser(req, res);
  await refreshMe();
  const u = cachedUser();
  res.json({
    status: u ? "authenticated" : "anonymous", localMode: true, cloudUrl, paired: isPaired(), lastError,
    user: u ? { id: u.id, name: u.display_name, avatar: u.avatar_url, createdAt: u.created_at, access: u.access, entitlements: u.entitlements } : null,
    providers: {}, plan: state?.plan ?? null,
    csrf: issueCsrf({ bidHash: r.bidHash, sessionId: null, authEpoch: r.authEpoch }),
  });
});
local.post("/api/local/pair/start", requireBrowser, requireCsrf, async (_req, res) => {
  try { res.json(await startPairing()); } catch (e: any) { res.status(502).json({ error: e?.message ?? String(e) }); }
});
local.get("/api/local/pair/status", async (_req, res) => {
  const status = await pollPairing();
  res.json({ status, paired: isPaired(), userCode: pending?.userCode ?? null });
});
local.post("/api/local/unpair", requireBrowser, requireCsrf, (_req, res) => { unpair(); res.json({ ok: true }); });
