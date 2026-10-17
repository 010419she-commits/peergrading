import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const csrf = crypto.randomBytes(32).toString("base64url");
const loopbackNames = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const localCsrf = () => csrf;

function localUrl(value: string, port: number | undefined): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && loopbackNames.has(url.hostname) && Number(url.port || 80) === port
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}

export function requireLocalHost(req: Request, res: Response, next: NextFunction) {
  if (localUrl(`http://${req.headers.host || ""}`, req.socket.localPort)) return next();
  res.status(403).json({ error: "invalid_host" });
}

export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const deny = (code: string) => req.is("application/x-www-form-urlencoded")
    ? res.status(403).type("text").send("请求校验失败，请返回重试")
    : res.status(403).json({ error: code });
  const origin = req.get("origin");
  if (origin ? !localUrl(origin, req.socket.localPort) : req.get("sec-fetch-site") !== "same-origin") return deny("bad_origin");
  const supplied = req.get("x-csrf-token") || (req.body as any)?._csrf;
  const expected = Buffer.from(csrf), token = Buffer.from(typeof supplied === "string" ? supplied : "");
  if (token.length !== expected.length || !crypto.timingSafeEqual(token, expected)) return deny("csrf");
  next();
}
