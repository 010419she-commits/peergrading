// Provider credentials remain on the server. Card details are collected by Airwallex's hosted page.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../auth/config.ts";
import { AuthError, timingEq } from "../auth/security.ts";

const env = (name: string) => (process.env[name] || "").trim();
const requireFields = (names: string[]) => {
  const missing = names.filter((name) => !env(name));
  if (missing.length) throw new AuthError("payment_not_configured", missing);
};
const wechatFields = ["WECHAT_PAY_MCH_ID", "WECHAT_PAY_APP_ID", "WECHAT_PAY_CERT_SERIAL", "WECHAT_PAY_PRIVATE_KEY_PATH", "WECHAT_PAY_API_V3_KEY", "WECHAT_PAY_PLATFORM_KEY_ID", "WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH"];
const airwallexFields = ["AIRWALLEX_CLIENT_ID", "AIRWALLEX_API_KEY", "AIRWALLEX_ACCOUNT_ID", "AIRWALLEX_WEBHOOK_SECRET"];
function keyFile(name: string, kind: "private" | "public") {
  try {
    const key = fs.readFileSync(path.resolve(config.root, env(name)), "utf8");
    const parsed = kind === "private" ? crypto.createPrivateKey(key) : crypto.createPublicKey(key);
    if (parsed.asymmetricKeyType !== "rsa" || (parsed.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error("RSA 2048 required");
    return parsed;
  } catch { throw new AuthError("payment_key_invalid", name); }
}
export function paymentProviders() {
  return [
    { id: "wechat", label: "微信支付", configured: wechatFields.every((name) => !!env(name)) },
    { id: "airwallex", label: "Visa / Mastercard", configured: airwallexFields.every((name) => !!env(name)) },
  ];
}
export function wechatSettings() {
  requireFields(wechatFields);
  const apiV3Key = env("WECHAT_PAY_API_V3_KEY");
  if (Buffer.byteLength(apiV3Key) !== 32) throw new AuthError("payment_config_invalid", "WECHAT_PAY_API_V3_KEY");
  return { mchId: env("WECHAT_PAY_MCH_ID"), appId: env("WECHAT_PAY_APP_ID"), certSerial: env("WECHAT_PAY_CERT_SERIAL"),
    platformKeyId: env("WECHAT_PAY_PLATFORM_KEY_ID"), apiV3Key,
    privateKey: keyFile("WECHAT_PAY_PRIVATE_KEY_PATH", "private"), publicKey: keyFile("WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH", "public") };
}
export function airwallexSettings() {
  requireFields(airwallexFields);
  const environment = env("AIRWALLEX_ENV") || "sandbox";
  if (!["sandbox", "production"].includes(environment)) throw new AuthError("payment_config_invalid", "AIRWALLEX_ENV");
  const countryCode = env("AIRWALLEX_COUNTRY_CODE") || "CN";
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new AuthError("payment_config_invalid", "AIRWALLEX_COUNTRY_CODE");
  return { clientId: env("AIRWALLEX_CLIENT_ID"), apiKey: env("AIRWALLEX_API_KEY"), accountId: env("AIRWALLEX_ACCOUNT_ID"), webhookSecret: env("AIRWALLEX_WEBHOOK_SECRET"),
    baseUrl: environment === "production" ? "https://api.airwallex.com" : "https://api.sandbox.airwallex.com",
    sdkEnv: environment === "production" ? "prod" : "demo", countryCode };
}

/** Five minutes of clock skew; timestamps are part of each provider's signature. */
function freshTimestamp(value: string | undefined, milliseconds = false) {
  if (!value || !/^\d{10,13}$/.test(value)) return false;
  const timestamp = Number(value) * (milliseconds ? 1 : 1000);
  return Number.isSafeInteger(timestamp) && Math.abs(Date.now() - timestamp) <= 300_000;
}
export type WechatHeaders = { serial?: string; timestamp?: string; nonce?: string; signature?: string };
export function verifyWechatSignature(raw: Buffer, headers: WechatHeaders, settings = wechatSettings()) {
  if (headers.serial !== settings.platformKeyId || !freshTimestamp(headers.timestamp) || !headers.nonce || !headers.signature || headers.signature.startsWith("WECHATPAY/SIGNTEST/")) return false;
  try {
    return crypto.verify("RSA-SHA256", Buffer.concat([Buffer.from(`${headers.timestamp}\n${headers.nonce}\n`), raw, Buffer.from("\n")]), settings.publicKey, Buffer.from(headers.signature, "base64"));
  } catch { return false; }
}
export function verifyAirwallexSignature(raw: Buffer, timestamp: string | undefined, signature: string | undefined, secret = airwallexSettings().webhookSecret) {
  if (!freshTimestamp(timestamp, true) || !signature || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = crypto.createHmac("sha256", secret).update(timestamp!).update(raw).digest("hex");
  return timingEq(expected, signature.toLowerCase());
}
export function decryptWechatResource(resource: any, key: string) {
  if (resource?.algorithm !== "AEAD_AES_256_GCM" || resource?.original_type !== "transaction" || typeof resource?.nonce !== "string" || typeof resource?.ciphertext !== "string") throw new AuthError("bad_payment_resource");
  try {
    const encrypted = Buffer.from(resource.ciphertext, "base64");
    if (encrypted.length < 17) throw new Error("empty ciphertext");
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(resource.nonce));
    decipher.setAuthTag(encrypted.subarray(-16));
    decipher.setAAD(Buffer.from(resource.associated_data || ""));
    return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8"));
  } catch { throw new AuthError("bad_payment_resource"); }
}

let inflight = 0;
async function providerFetch(url: string, init: RequestInit) {
  if (inflight >= config.maxInflightExternal) throw new AuthError("payment_busy");
  inflight++;
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(config.fetchTimeoutMs) });
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > 1024 * 1024) throw new AuthError("payment_bad_response");
    return { response, raw };
  } catch (error: any) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(error?.name === "TimeoutError" ? "payment_timeout" : "payment_network");
  } finally { inflight--; }
}
function parseResponse(raw: Buffer) {
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new AuthError("payment_bad_response"); }
}
export async function wechatRequest(method: "POST" | "GET", route: string, body?: object) {
  const settings = wechatSettings(), rawBody = body ? JSON.stringify(body) : "";
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(16).toString("hex");
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${method}\n${route}\n${timestamp}\n${nonce}\n${rawBody}\n`), settings.privateKey).toString("base64");
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${settings.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${settings.certSerial}",signature="${signature}"`;
  const { response, raw } = await providerFetch(`https://api.mch.weixin.qq.com${route}`, { method, headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "PeerGrading/0.2", "Wechatpay-Serial": settings.platformKeyId }, ...(body ? { body: rawBody } : {}) });
  if (!verifyWechatSignature(raw, { serial: response.headers.get("wechatpay-serial") || undefined, timestamp: response.headers.get("wechatpay-timestamp") || undefined, nonce: response.headers.get("wechatpay-nonce") || undefined, signature: response.headers.get("wechatpay-signature") || undefined }, settings)) throw new AuthError("payment_bad_response_signature");
  if (!response.ok) throw new AuthError("payment_provider_error", response.status);
  return raw.length ? parseResponse(raw) : null;
}

let tokenCache: { credentialTag: string; token: string; expires: number } | null = null;
async function airwallexToken() {
  const s = airwallexSettings();
  const credentialTag = crypto.createHash("sha256").update(`${s.baseUrl}|${s.clientId}|${s.apiKey}`).digest("hex");
  if (tokenCache?.credentialTag === credentialTag && tokenCache.expires > Date.now() + 60_000) return tokenCache.token;
  const { response, raw } = await providerFetch(`${s.baseUrl}/api/v1/authentication/login`, { method: "POST", headers: { "Content-Type": "application/json", "x-client-id": s.clientId, "x-api-key": s.apiKey } });
  if (!response.ok) throw new AuthError("payment_provider_auth", response.status);
  const body = parseResponse(raw);
  if (typeof body.token !== "string" || !body.token) throw new AuthError("payment_bad_response");
  const expiry = Date.parse(body.expires_at);
  // Without an expiry, do not retain the token between requests.
  tokenCache = { credentialTag, token: body.token, expires: Number.isFinite(expiry) ? expiry : Date.now() };
  return body.token;
}
export async function airwallexRequest(method: "POST" | "GET", route: string, body?: object) {
  const settings = airwallexSettings(), token = await airwallexToken();
  const { response, raw } = await providerFetch(`${settings.baseUrl}${route}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) {
    if (response.status === 401) tokenCache = null;
    throw new AuthError("payment_provider_error", response.status);
  }
  return parseResponse(raw);
}
