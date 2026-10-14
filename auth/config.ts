// auth/config.ts — 配置（按 v9 §5.3，加入试用 / 定价规则）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
const dataDir = path.resolve(root, process.env.DATA_DIR || "data");
fs.mkdirSync(dataDir, { recursive: true });

// 会话密钥：生产必须显式配置；本地开发缺失时生成并持久化到 data/.session-secret
let sessionSecret = process.env.SESSION_SECRET || "";
if (!sessionSecret) {
  if (isProd) throw new Error("缺少环境变量 SESSION_SECRET（openssl rand -hex 32）");
  const f = path.join(dataDir, ".session-secret");
  try { sessionSecret = fs.readFileSync(f, "utf8").trim(); } catch {}
  if (!sessionSecret) { sessionSecret = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(f, sessionSecret, { mode: 0o600 }); }
}
if (sessionSecret.length < 32) throw new Error("SESSION_SECRET 至少 32 字符");
if (isProd && !baseUrl.startsWith("https://")) throw new Error("生产环境 BASE_URL 必须为 https");

const isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl);

export const config = {
  root, port, isProd, baseUrl,
  siteOrigin: new URL(baseUrl).origin,
  sessionSecret,
  dbPath: path.join(dataDir, "app.db"),
  google: { clientId: process.env.GOOGLE_CLIENT_ID || "", clientSecret: process.env.GOOGLE_CLIENT_SECRET || "" },
  /** 本地开发登录（无需任何第三方凭证）。仅当非生产 + BASE_URL 为 localhost + DEV_LOGIN=1 */
  devLogin: !isProd && isLocalBase && process.env.DEV_LOGIN === "1",
  /** 云端的网页版工作台（用服务器上的 agent）。产品主体是桌面软件，生产默认关闭 */
  webWorkspace: !isProd || process.env.WEB_WORKSPACE === "1",
  txTtlSec: 600,
  sessionTtlSec: 30 * 86400,
  reverifyWindowSec: 15 * 60,
  csrfTtlSec: 3600,
  fetchTimeoutMs: 8000,
  maxInflightExternal: 50,
  browserStateRetentionSec: 30 * 86400,

  /** 试用与定价（站主规则：3 天或 5 次试用，之后 18.8 元买断） */
  plan: {
    code: process.env.PLAN_CODE || "monthly",
    version: 1,
    name: process.env.PRODUCT_NAME || "PeerGrading",
    entitlement: "member",
    mode: (process.env.PLAN_MODE === "permanent" ? "permanent" : "days") as "permanent" | "days",   // 默认月付；PLAN_MODE=permanent 改为买断
    days: Number(process.env.PLAN_DAYS || 30),
    priceCents: Number(process.env.PRICE_CENTS || 1800),
    currency: process.env.CURRENCY || "CNY",
    trialDays: Number(process.env.TRIAL_DAYS || 3),
    trialUses: Number(process.env.TRIAL_USES || 5),
  },
  payment: {
    merchantId: process.env.MERCHANT_ID || "default",
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || "",
    instructions: process.env.PAY_INSTRUCTIONS || "",
    qrUrl: process.env.PAY_QR_URL || "",
  },
};

export const googleReady = () => !!(config.google.clientId && config.google.clientSecret);
