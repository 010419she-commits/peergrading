// Mail delivery only. Codes are never included in API responses or application logs.
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { config } from "./config.ts";
import { AuthError, fetchJson } from "./security.ts";

export function emailReady() {
  const c = config.email;
  if (c.testOutboxDir) return true;
  if (!c.from || /[\r\n]/.test(c.from)) return false;
  if (c.provider === "resend") return !!c.resendKey;
  return c.provider === "smtp" && !!c.smtp.host && !!c.smtp.user && !!c.smtp.pass
    && Number.isInteger(c.smtp.port) && c.smtp.port > 0 && c.smtp.port <= 65535;
}

export async function sendEmailCode(email: string, code: string, id: string) {
  if (!emailReady()) throw new AuthError("mail_unavailable");
  const subject = "PeerGrading 邮箱验证码";
  const text = `您的 PeerGrading 验证码：${code}\n\n验证码 10 分钟内有效，仅可使用一次。请勿向他人提供验证码。\n如果不是您本人操作，请忽略这封邮件。`;
  try {
    if (config.email.testOutboxDir) {
      // This switch is enabled only under NODE_ENV=test, never in production.
      const directory = path.resolve(config.email.testOutboxDir);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify({ to: email, subject, text }), { mode: 0o600, flag: "wx" });
      return;
    }
    if (config.email.provider === "resend") {
      const response = await fetchJson("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${config.email.resendKey}`, "content-type": "application/json", "idempotency-key": `email-challenge-${id}` },
        body: JSON.stringify({ from: config.email.from, to: [email], subject, text }),
      });
      if (!response.ok || typeof response.body?.id !== "string") throw new AuthError("mail_delivery_failed");
      return;
    }
    const c = config.email.smtp;
    const transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.secure, requireTLS: !c.secure,
      auth: { user: c.user, pass: c.pass },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({ from: config.email.from, to: email, subject, text });
      if (!result.accepted?.length || result.rejected?.length) throw new AuthError("mail_delivery_failed");
    } finally { transport.close(); }
  } catch {
    // Provider error messages can contain credentials, addresses or message contents.
    throw new AuthError("mail_delivery_failed");
  }
}
