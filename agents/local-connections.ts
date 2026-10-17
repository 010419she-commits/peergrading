// User-supplied OpenAI-compatible services; credentials stay in the local data directory.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

export type LocalModelConnection = {
  id: string;
  name: string;
  baseUrl: string;
  model?: string;
  apiKey?: string;
};
export type PublicLocalModelConnection = Omit<LocalModelConnection, "apiKey"> & { hasApiKey: boolean };
export type LocalModelConnectionInput = { id?: unknown; name?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown };
type ConnectionErrorCode = "invalid_local_model_connection" | "local_models_limit" | "local_model_not_found" | "invalid_local_models_store";
export class LocalConnectionError extends Error {
  code: ConnectionErrorCode;
  constructor(code: ConnectionErrorCode) { super(code); this.code = code; }
}

const MAX_CONNECTIONS = 12;
const STORE_FILE = "local-models.json";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = (): never => { throw new LocalConnectionError("invalid_local_model_connection"); };

/** Only literal local network addresses are accepted; arbitrary DNS names are excluded. */
export function normalizeLocalBaseUrl(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const input = value.trim();
  if (!input || input.length > 2048 || /[\s\\@?#\u0000-\u001f\u007f]/.test(input)) return invalid();
  let url: URL;
  try { url = new URL(input); } catch { return invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return invalid();
  if (!["/", "/v1", "/v1/"].includes(url.pathname)) return invalid();
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  let local = host === "localhost" || host === "::1";
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    local = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  } else if (isIP(host) === 6 && /^f[cd][0-9a-f]{2}:/.test(host)) local = true;
  if (!local) return invalid();
  return `${url.origin}/v1`;
}

function text(value: unknown, maximum: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  const result = value.trim();
  if (result.length > maximum || (required && !result)) return invalid();
  return result || undefined;
}

function validateRecord(value: unknown): LocalModelConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as LocalModelConnectionInput;
  if (typeof record.id !== "string" || !UUID_RE.test(record.id)) return invalid();
  const name = text(record.name, 80, true)!;
  const baseUrl = normalizeLocalBaseUrl(record.baseUrl);
  const model = text(record.model, 256);
  const apiKey = text(record.apiKey, 4096);
  return { id: record.id, name, baseUrl, ...(model ? { model } : {}), ...(apiKey ? { apiKey } : {}) };
}

export function loadLocalConnections(directory: string): LocalModelConnection[] {
  let source: string;
  try { source = fs.readFileSync(path.join(directory, STORE_FILE), "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  try {
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length > MAX_CONNECTIONS) throw new Error();
    const connections = parsed.map(validateRecord);
    if (new Set(connections.map((connection) => connection.id)).size !== connections.length) throw new Error();
    return connections;
  } catch { throw new LocalConnectionError("invalid_local_models_store"); }
}

function persist(directory: string, connections: LocalModelConnection[]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.local-models-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(connections, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, path.join(directory, STORE_FILE));
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

export function saveLocalConnection(directory: string, input: LocalModelConnectionInput): LocalModelConnection {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  if (input.id !== undefined && (typeof input.id !== "string" || !input.id)) return invalid();
  const connections = loadLocalConnections(directory);
  const index = input.id === undefined ? -1 : connections.findIndex((connection) => connection.id === input.id);
  if (input.id !== undefined && index === -1) throw new LocalConnectionError("local_model_not_found");
  if (index === -1 && connections.length >= MAX_CONNECTIONS) throw new LocalConnectionError("local_models_limit");
  const previous = connections[index];
  const connection = validateRecord({
    id: previous?.id ?? randomUUID(),
    name: input.name,
    baseUrl: input.baseUrl,
    model: input.model === undefined ? previous?.model : input.model,
    apiKey: input.apiKey === undefined ? previous?.apiKey : input.apiKey,
  });
  if (index === -1) connections.push(connection);
  else connections[index] = connection;
  persist(directory, connections);
  return connection;
}

export function removeLocalConnection(directory: string, id: string): boolean {
  const connections = loadLocalConnections(directory);
  const remaining = connections.filter((connection) => connection.id !== id);
  if (remaining.length === connections.length) return false;
  persist(directory, remaining);
  return true;
}

export function redactLocalConnection(connection: LocalModelConnection): PublicLocalModelConnection {
  const { apiKey, ...publicConnection } = connection;
  return { ...publicConnection, hasApiKey: Boolean(apiKey) };
}

export function publicLocalConnections(directory: string): PublicLocalModelConnection[] {
  return loadLocalConnections(directory).map(redactLocalConnection);
}
