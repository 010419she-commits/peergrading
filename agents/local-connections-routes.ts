import { Router, type RequestHandler } from "express";
import { LocalConnectionError, publicLocalConnections, redactLocalConnection, removeLocalConnection, saveLocalConnection } from "./local-connections.ts";
import type { AgentInfo } from "./types.ts";

/** Local-only model settings routes; the caller supplies the local CSRF boundary. */
export function createLocalConnectionsRouter({ directory, available, requireCsrf, onChanged }: {
  directory: string;
  available: boolean;
  requireCsrf: RequestHandler;
  onChanged?: () => void;
}) {
  const router = Router();
  const requireLocal: RequestHandler = (_req, res, next) => available ? next() : res.status(403).json({ error: "local_models_local_only" });
  router.get("/local-models", requireLocal, (_req, res) => res.json({ available: true, connections: publicLocalConnections(directory) }));
  const save: RequestHandler = (req, res, next) => {
    try {
      const connection = saveLocalConnection(directory, req.body);
      onChanged?.();
      res.json({ connection: redactLocalConnection(connection) });
    }
    catch (error) { next(error); }
  };
  router.post("/local-models", requireLocal, requireCsrf, save);
  router.delete("/local-models/:id", requireLocal, requireCsrf, (req, res, next) => {
    try {
      if (!removeLocalConnection(directory, String(req.params.id))) return res.status(404).json({ error: "local_model_not_found" });
      onChanged?.();
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (!(error instanceof LocalConnectionError)) return next(error);
    const status = error.code === "local_model_not_found" ? 404 : error.code === "local_models_limit" ? 409 : error.code === "invalid_local_models_store" ? 500 : 400;
    res.status(status).json({ error: error.code });
  });
  return router;
}

/** Return display metadata without mutating runners used for actual model calls. */
export function publicAgentInfo(agent: AgentInfo) {
  const runner: Record<string, unknown> = { ...agent.runner };
  delete runner.apiKey;
  if (runner.openai && typeof runner.openai === "object") {
    const openai: Record<string, unknown> = { ...runner.openai };
    delete openai.apiKey;
    runner.openai = openai;
  }
  return { ...agent, runner };
}
