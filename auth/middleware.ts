// auth/middleware.ts — 用户挂载与访问控制（v9 §5.14 + 试用 / 会员访问）
import type { Request, Response, NextFunction } from "express";
import { readSession } from "./session.ts";
import { getUser } from "./users.ts";
import { hasEntitlement } from "./entitlements.ts";
import { accessStatus } from "../billing/access.ts";

export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const r = req as any;
  r.session = readSession(req);
  r.user = r.session ? getUser(r.session.user_id) : null;
  if (r.user && r.user.status !== "active") { r.user = null; r.session = null; }
  next();
}
export const noStore = (_req: Request, res: Response, next: NextFunction) => { res.set("Cache-Control", "no-store"); next(); };
export const requireBrowser = (req: Request, res: Response, next: NextFunction) => (req as any).bidHash ? next() : res.status(403).json({ error: "no_browser" });
export const requireAuthApi = (req: Request, res: Response, next: NextFunction) => (req as any).user ? next() : res.status(401).json({ error: "unauthenticated" });
export const requireEntitlementApi = (code: string) => (req: Request, res: Response, next: NextFunction) => {
  const u = (req as any).user;
  if (!u) return res.status(401).json({ error: "unauthenticated" });
  if (!hasEntitlement(u.id, code)) return res.status(403).json({ error: "entitlement_required", entitlement: code });
  next();
};
/** 产品使用权：会员 或 试用期内（天数与次数双重限制） */
export const requireAccessApi = (req: Request, res: Response, next: NextFunction) => {
  const u = (req as any).user;
  if (!u) return res.status(401).json({ error: "unauthenticated" });
  const a = accessStatus(u);
  if (!a.allowed) return res.status(403).json({ error: "payment_required", access: a });
  (req as any).access = a;
  next();
};
export const requireAccessPage = (req: Request, res: Response, next: NextFunction) => {
  const u = (req as any).user;
  if (!u) return res.redirect(`/login?return_to=${encodeURIComponent(req.path)}&reason=required`);
  if (!accessStatus(u).allowed) return res.redirect("/account#pricing");
  next();
};
