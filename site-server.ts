import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./runtime-config.ts";

const publicFiles = new Map(Object.entries({
  "/": "index.html",
  "/index.html": "index.html",
  "/installers.json": "installers.json",
  "/privacy": "privacy.html",
  "/privacy.html": "privacy.html",
  "/terms": "terms.html",
  "/terms.html": "terms.html",
  "/site.css": "site.css",
  "/site-i18n.js": "site-i18n.js",
  "/site-theme.js": "site-theme.js",
  "/download-site.js": "download-site.js",
  "/collaboration-demo.js": "collaboration-demo.js",
  "/legal.css": "legal.css",
  "/icon.png": "icon.png",
  "/favicon.ico": "favicon.ico",
}));

export function createSiteApp(publicDirectory = path.join(config.root, "public")) {
  const app = express();
  app.disable("x-powered-by");
  for (const [route, file] of publicFiles) app.get(route, (_req, res) => res.sendFile(path.join(publicDirectory, file)));
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "not_found" });
    res.status(404).type("text").send("Not found");
  });
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = Number(err?.status) || 500;
    res.status(status).type("text").send(status === 404 ? "Not found" : "服务暂时不可用，请稍后重试");
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createSiteApp();
  const host = process.env.HOST || "0.0.0.0";
  app.listen(config.port, host, () => console.log(`PeerGrading 官网: http://${host}:${config.port}`));
}
