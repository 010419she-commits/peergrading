import type { Request, Response, NextFunction } from "express";

// Bounded, per-process protection for short-lived device authorization endpoints.
const buckets = new Map<string, { count: number; resetAt: number }>();
export function deviceLimit(scope: string, limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const current = Date.now(), key = `${scope}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    if (buckets.size > 5000) for (const [k, b] of buckets) if (b.resetAt <= current) buckets.delete(k);
    // Do not create unlimited buckets under a distributed flood.
    if (!buckets.has(key) && buckets.size >= 10000) return res.status(429).set("Retry-After", "60").json({ error: "rate_limited" });
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= current) { bucket = { count: 0, resetAt: current + windowMs }; buckets.set(key, bucket); }
    if (++bucket.count > limit) return res.status(429).set("Retry-After", String(Math.ceil((bucket.resetAt - current) / 1000))).json({ error: "rate_limited" });
    next();
  };
}
