import { Router, type RequestHandler } from "express";
import { ApiConnectionError, publicApiConnections, redactApiConnection, removeApiConnection, saveApiConnection, type ApiLookup } from "./api-connections.ts";
import { API_PRESETS } from "./api-presets.ts";

/** Mount under the caller's existing authenticated API boundary. */
export function createApiConnectionsRouter({ directory, available, requireCsrf, onChanged, lookup }: {
  directory: string;
  available: boolean;
  requireCsrf: RequestHandler;
  onChanged?: () => void;
  lookup?: ApiLookup;
}) {
  const router = Router();
  const requireLocal: RequestHandler = (_req, res, next) => available ? next() : res.status(403).json({ error: "api_models_local_only" });
  router.get("/api-models", requireLocal, (_req, res, next) => {
    try { res.json({ available: true, connections: publicApiConnections(directory), presets: API_PRESETS }); }
    catch (error) { next(error); }
  });
  router.post("/api-models", requireLocal, requireCsrf, async (req, res, next) => {
    try {
      const connection = await saveApiConnection(directory, req.body, { lookup });
      onChanged?.(); res.json({ connection: redactApiConnection(connection) });
    } catch (error) { next(error); }
  });
  router.delete("/api-models/:id", requireLocal, requireCsrf, (req, res, next) => {
    try {
      if (!removeApiConnection(directory, String(req.params.id))) return res.status(404).json({ error: "api_model_not_found" });
      onChanged?.(); res.json({ ok: true });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (!(error instanceof ApiConnectionError)) return next(error);
    const status = error.code === "api_model_not_found" ? 404 : error.code === "api_models_limit" ? 409 : error.code === "invalid_api_models_store" ? 500 : 400;
    res.status(status).json({ error: error.code });
  });
  return router;
}
