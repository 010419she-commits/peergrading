// auth/device.ts — 桌面软件配对（设备授权码流程）与设备令牌（云端，peergrading.ai 侧）
import { Router, type Request, type Response, type NextFunction } from "express";
import { randomInt } from "node:crypto";
import { q, transaction } from "./db.ts";
import { config } from "./config.ts";
import { now, randomToken, sha256, requireCsrf } from "./security.ts";
import { requireAuthApi, requireBrowser } from "./middleware.ts";
import { getUser } from "./users.ts";
import { entitlementSummary } from "./entitlements.ts";
import { accessStatus, recordUsage } from "../billing/access.ts";
import { publicPlan } from "../billing/plan.ts";
import { desktopReturnUrl, desktopStateValid } from "./desktop-return.ts";
import { deviceLimit } from "./device-limits.ts";

export const device = Router();
const CODE_TTL = 10 * 60;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const userCode = () => { let s = ""; for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]; return `${s.slice(0, 4)}-${s.slice(4)}`; };
const normalizeCode = (value: unknown) => {
  if (typeof value !== "string") return "";
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === 8 && [...code].every((c) => USER_CODE_ALPHABET.includes(c)) ? `${code.slice(0, 4)}-${code.slice(4)}` : "";
};
const redirectFor = (row: any) => {
  const callback = desktopReturnUrl(row.loopback_return_url);
  return callback && desktopStateValid(row.loopback_state) ? `${callback}?state=${encodeURIComponent(row.loopback_state)}` : undefined;
};

/** 软件发起配对：返回短码与验证页地址 */
device.post("/api/device/start", deviceLimit("start", 30, 10 * 60_000), (req, res) => {
  const deviceName = String(req.body?.deviceName ?? "").slice(0, 80) || null;
  const hasReturn = req.body?.loopbackReturnUrl != null || req.body?.state != null;
  const callback = hasReturn ? desktopReturnUrl(req.body?.loopbackReturnUrl) : null;
  if (hasReturn && (!callback || !desktopStateValid(req.body?.state))) return res.status(400).json({ error: "invalid_desktop_return" });
  q("DELETE FROM device_codes WHERE expires_at < ?").run(now() - 3600);
  let code = "", deviceCode = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    code = userCode(); deviceCode = randomToken(32);
    const inserted = q("INSERT OR IGNORE INTO device_codes (device_code, user_code, device_name, expires_at, loopback_return_url, loopback_state) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(deviceCode), code, deviceName, now() + CODE_TTL, callback, callback ? req.body.state : null);
    if (Number(inserted.changes)) break;
    deviceCode = "";
  }
  if (!deviceCode) return res.status(503).json({ error: "device_code_busy" });
  // 生产用配置的 BASE_URL；开发/局域网测试时用软件实际访问到的地址，避免把 localhost 发给另一台电脑
  const base = config.isProd ? config.baseUrl : `${req.protocol}://${req.get("host")}`;
  res.json({ deviceCode, userCode: code, verificationUrl: `${base}/device?code=${encodeURIComponent(code)}`, expiresIn: CODE_TTL, interval: 3 });
});

/** 软件轮询：pending → approved 时换发长期设备令牌（只发一次） */
device.post("/api/device/poll", deviceLimit("poll", 600, 60_000), (req, res) => {
  const dc = String(req.body?.deviceCode ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(dc)) return res.status(400).json({ error: "bad_request" });
  const row = q("SELECT * FROM device_codes WHERE device_code = ?").get(sha256(dc));
  if (!row) return res.status(404).json({ error: "unknown_code" });
  if (row.status === "consumed") return res.json({ status: "consumed" });
  if (row.expires_at <= now()) return res.json({ status: "expired" });
  if (row.status === "denied") return res.json({ status: "denied" });
  if (row.status !== "approved" || !row.user_id) return res.json({ status: "pending" });
  const u = getUser(row.user_id);
  if (!u || u.status !== "active") {
    q("UPDATE device_codes SET status = 'denied' WHERE device_code = ?").run(row.device_code);
    return res.json({ status: "denied", error: "account_unavailable" });
  }
  const token = randomToken(32);
  const issued = transaction(() => {
    const changed = q("UPDATE device_codes SET status = 'consumed' WHERE device_code = ? AND status = 'approved' AND expires_at > ?").run(row.device_code, now());
    if (!Number(changed.changes)) return false;
    q("INSERT INTO device_tokens (id, user_id, device_name, last_seen_at) VALUES (?, ?, ?, ?)").run(sha256(token), row.user_id, row.device_name, now());
    return true;
  });
  if (!issued) return res.json({ status: "consumed" });
  res.json({ status: "approved", deviceToken: token, user: userView(u), plan: publicPlan() });
});

/** 网页端：已登录用户确认配对码 */
device.post("/api/device/approve", deviceLimit("decision", 40, 60_000), requireBrowser, requireAuthApi, requireCsrf, (req, res) => {
  const u = (req as any).user;
  if (u.status !== "active") return res.status(401).json({ error: "account_unavailable" });
  const formatted = normalizeCode(req.body?.userCode);
  const row = formatted && q("SELECT * FROM device_codes WHERE user_code = ?").get(formatted);
  if (!row) return res.status(404).json({ error: "unknown_code" });
  if (row.expires_at <= now() || row.status !== "pending") return res.status(409).json({ error: "code_unusable" });
  q("UPDATE device_codes SET status = 'approved', user_id = ? WHERE device_code = ? AND status = 'pending'").run(u.id, row.device_code);
  res.set("Referrer-Policy", "no-referrer").json({ ok: true, deviceName: row.device_name, redirectUrl: redirectFor(row) });
});
device.post("/api/device/deny", deviceLimit("decision", 40, 60_000), requireBrowser, requireAuthApi, requireCsrf, (req, res) => {
  const code = normalizeCode(req.body?.userCode);
  const row = code && q("SELECT * FROM device_codes WHERE user_code = ?").get(code);
  if (!row) return res.status(404).json({ error: "unknown_code" });
  if (row.expires_at <= now() || row.status !== "pending") return res.status(409).json({ error: "code_unusable" });
  q("UPDATE device_codes SET status = 'denied' WHERE device_code = ? AND status = 'pending'").run(row.device_code);
  res.set("Referrer-Policy", "no-referrer").json({ ok: true, redirectUrl: redirectFor(row) });
});

/** 设备令牌鉴权（Authorization: Bearer <token>） */
export function requireDevice(req: Request, res: Response, next: NextFunction) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(req.get("authorization") || "");
  if (!m) return res.status(401).json({ error: "no_device_token" });
  const row = q("SELECT * FROM device_tokens WHERE id = ? AND revoked_at IS NULL").get(sha256(m[1]));
  if (!row) return res.status(401).json({ error: "device_token_invalid" });
  const u = getUser(row.user_id);
  if (!u || u.status !== "active") return res.status(401).json({ error: "account_unavailable" });
  q("UPDATE device_tokens SET last_seen_at = ? WHERE id = ?").run(now(), row.id);
  (req as any).user = u; (req as any).deviceToken = row;
  next();
}
function userView(u: any) {
  return { id: u.id, name: u.display_name, avatar: u.avatar_url, createdAt: u.created_at, access: accessStatus(u), entitlements: entitlementSummary(u.id) };
}
/** 软件启动 / 定期核对：用户与使用权 */
device.get("/api/device/me", requireDevice, (req, res) => res.json({ user: userView((req as any).user), plan: publicPlan() }));
device.post("/api/device/logout", requireDevice, (req, res) => {
  q("UPDATE device_tokens SET revoked_at = ? WHERE id = ?").run(now(), (req as any).deviceToken.id);
  res.json({ ok: true });
});
/** 软件开始一次协作前：记一次试用用量并返回最新使用权；无使用权则 403 */
device.post("/api/device/usage", requireDevice, (req, res) => {
  const u = (req as any).user;
  const a = accessStatus(u);
  if (!a.allowed) return res.status(403).json({ error: "payment_required", access: a });
  recordUsage(u, String(req.body?.ref ?? "desktop").slice(0, 80));
  res.json({ ok: true, access: accessStatus(u) });
});
/** 网页端账号页：我的设备 */
device.get("/api/device/list", requireAuthApi, (req, res) => {
  const u = (req as any).user;
  res.json({ devices: q("SELECT id, device_name, created_at, last_seen_at FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC").all(u.id).map((d: any) => ({ id: d.id.slice(0, 12), deviceName: d.device_name, createdAt: d.created_at, lastSeenAt: d.last_seen_at })) });
});
device.post("/api/device/revoke", requireBrowser, requireAuthApi, requireCsrf, (req, res) => {
  const u = (req as any).user;
  const prefix = String(req.body?.id ?? "").replace(/[^a-f0-9]/g, "").slice(0, 12);
  if (prefix.length < 12) return res.status(400).json({ error: "bad_request" });
  const r = q("UPDATE device_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND substr(id, 1, 12) = ?").run(now(), u.id, prefix);
  res.json({ ok: Number(r.changes) > 0 });
});
export function cleanupDeviceCodes() { q("DELETE FROM device_codes WHERE expires_at < ?").run(now() - 3600); }
