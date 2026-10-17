// Explicit cloud API profiles are separate from local/LAN model discovery.
// Credentials remain in the local data directory and are never public metadata.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type ApiProvider = "kimi" | "deepseek" | "qwen" | "glm" | "doubao" | "custom";
export type ApiConnection = { id: string; name: string; provider: ApiProvider; baseUrl: string; model: string; apiKey: string };
export type PublicApiConnection = Omit<ApiConnection, "apiKey"> & { hasApiKey: boolean };
export type ApiConnectionInput = { id?: unknown; name?: unknown; provider?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown };
export type ApiLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;
type ErrorCode = "invalid_api_model_connection" | "api_model_key_required" | "api_model_endpoint_private" | "api_model_endpoint_unavailable" | "api_models_limit" | "api_model_not_found" | "invalid_api_models_store";

export class ApiConnectionError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode) { super(code); this.name = "ApiConnectionError"; this.code = code; }
}
const PROVIDERS = new Set<ApiProvider>(["kimi", "deepseek", "qwen", "glm", "doubao", "custom"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONNECTIONS = 12;
const STORE_FILE = "api-models.json";
const invalid = (): never => { throw new ApiConnectionError("invalid_api_model_connection"); };
const privateEndpoint = (): never => { throw new ApiConnectionError("api_model_endpoint_private"); };

/** Require globally routable literal addresses, including all DNS answers. */
export function isPublicApiAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes("%")) return false;
  // This also excludes loopback, unspecified, ULA, link-local, mapped IPv4,
  // NAT64 and multicast addresses. Transition/documentation blocks are denied.
  const parts = address.toLowerCase().split(":");
  const first = Number.parseInt(parts[0], 16), second = Number.parseInt(parts[1] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8))
    && first !== 0x2002 && first !== 0x3ffe && !(first === 0x3fff && second <= 0x0fff);
}

/** Preserve custom API prefixes; the backend adds /chat/completions. */
export function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  const input = value.trim();
  if (!input || input.length > 2048 || /[\s\\@?#]/.test(input)) return invalid();
  let url: URL;
  try { url = new URL(input); } catch { return invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return invalid();
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { return invalid(); }
  if (/[\\\u0000-\u001f\u007f]/.test(decodedPath)) return invalid();
  // This field is an API base prefix; chat adds this resource path itself.
  if (/\/chat\/completions$/i.test(decodedPath.replace(/\/+$/, ""))) return invalid();
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (isIP(host)) { if (!isPublicApiAddress(host)) return privateEndpoint(); }
  else {
    if (!host.includes(".") || host.length > 253 || !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return privateEndpoint();
    if (/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|private|arpa|onion|test|invalid|example)$/.test(host)) return privateEndpoint();
    url.hostname = host;
  }
  const normalized = url.origin + url.pathname.replace(/\/+$/, "");
  if (normalized.length > 2048) return invalid();
  return normalized;
}

export async function assertPublicApiEndpoint(baseUrl: string, lookup: ApiLookup = (host) => dnsLookup(host, { all: true, verbatim: true })): Promise<void> {
  const host = new URL(normalizeApiBaseUrl(baseUrl)).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answers = await Promise.race([lookup(host), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ApiConnectionError("api_model_endpoint_unavailable")), 5000); })]);
    if (!answers.length) throw new ApiConnectionError("api_model_endpoint_unavailable");
    if (answers.some((answer) => !isPublicApiAddress(answer.address))) return privateEndpoint();
  } catch (error) {
    if (error instanceof ApiConnectionError) throw error;
    throw new ApiConnectionError("api_model_endpoint_unavailable");
  } finally { if (timer) clearTimeout(timer); }
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return invalid();
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) return invalid();
  return normalized;
}
function apiKey(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const key = value.trim();
  if (!key) throw new ApiConnectionError("api_model_key_required");
  if (key.length > 4096 || /[^\x21-\x7e]/.test(key)) return invalid();
  return key;
}
function validateRecord(value: unknown): ApiConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as ApiConnectionInput;
  if (typeof record.id !== "string" || !UUID.test(record.id) || !PROVIDERS.has(record.provider as ApiProvider)) return invalid();
  return { id: record.id, name: text(record.name, 80), provider: record.provider as ApiProvider, baseUrl: normalizeApiBaseUrl(record.baseUrl), model: text(record.model, 256), apiKey: apiKey(record.apiKey) };
}

export function loadApiConnections(directory: string): ApiConnection[] {
  let source: string;
  try {
    const file = path.join(directory, STORE_FILE);
    if (fs.statSync(file).size > 128 * 1024) throw new ApiConnectionError("invalid_api_models_store");
    source = fs.readFileSync(file, "utf8");
  } catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  try {
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length > MAX_CONNECTIONS) throw new Error();
    const connections = parsed.map(validateRecord);
    if (new Set(connections.map((connection) => connection.id)).size !== connections.length) throw new Error();
    return connections;
  } catch { throw new ApiConnectionError("invalid_api_models_store"); }
}
function persist(directory: string, connections: ApiConnection[]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.api-models-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(connections, null, 2)}\n`, { mode: 0o600, flag: "wx", flush: true });
    fs.renameSync(temporary, path.join(directory, STORE_FILE));
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

export async function saveApiConnection(directory: string, input: ApiConnectionInput, options: { lookup?: ApiLookup } = {}): Promise<ApiConnection> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  if (input.id !== undefined && (typeof input.id !== "string" || !UUID.test(input.id))) return invalid();
  const name = text(input.name, 80), model = text(input.model, 256), baseUrl = normalizeApiBaseUrl(input.baseUrl);
  if (!PROVIDERS.has(input.provider as ApiProvider)) return invalid();
  const provider = input.provider as ApiProvider;
  const suppliedKey = input.apiKey === undefined ? undefined : apiKey(input.apiKey);
  const assemble = (connections: ApiConnection[]) => {
    const index = input.id === undefined ? -1 : connections.findIndex((connection) => connection.id === input.id);
    if (input.id !== undefined && index < 0) throw new ApiConnectionError("api_model_not_found");
    if (index < 0 && connections.length >= MAX_CONNECTIONS) throw new ApiConnectionError("api_models_limit");
    const previous = connections[index];
    const canRetain = previous?.provider === provider && previous?.baseUrl === baseUrl;
    const key = suppliedKey ?? (canRetain ? previous.apiKey : undefined);
    if (!key) throw new ApiConnectionError("api_model_key_required");
    return { index, connection: { id: previous?.id ?? randomUUID(), name, provider, baseUrl, model, apiKey: key } };
  };
  assemble(loadApiConnections(directory)); // Reject invalid updates before DNS work.
  await assertPublicApiEndpoint(baseUrl, options.lookup);
  // DNS lookup yields the event loop: re-read to avoid losing another save or
  // retaining its credentials after a concurrent endpoint/provider change.
  const connections = loadApiConnections(directory), { index, connection } = assemble(connections);
  if (index < 0) connections.push(connection); else connections[index] = connection;
  persist(directory, connections);
  return connection;
}

export function removeApiConnection(directory: string, id: string): boolean {
  const connections = loadApiConnections(directory), remaining = connections.filter((connection) => connection.id !== id);
  if (remaining.length === connections.length) return false;
  persist(directory, remaining); return true;
}
export function redactApiConnection(connection: ApiConnection): PublicApiConnection {
  return { id: connection.id, name: connection.name, provider: connection.provider, baseUrl: connection.baseUrl, model: connection.model, hasApiKey: Boolean(connection.apiKey) };
}
export function publicApiConnections(directory: string): PublicApiConnection[] { return loadApiConnections(directory).map(redactApiConnection); }
