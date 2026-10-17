import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.basename(directory) === "dist" ? path.resolve(directory, "..") : directory;
const port = Number(process.env.PORT || 3000);

export const config = {
  root,
  port,
  isProd: process.env.NODE_ENV === "production",
  dataDir: path.resolve(root, process.env.DATA_DIR || "data"),
  sessionsDir: path.resolve(process.env.SESSIONS_DIR || path.join(root, "sessions")),
};

export const LOCAL_HOST = "127.0.0.1";
