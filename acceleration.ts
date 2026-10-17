import { createHash } from "node:crypto";
import type { ChatResult, RunnerSpec } from "./agents/types.ts";

export interface AccelerationOptions {
  speculativeReview?: boolean;
  cache?: boolean;
}

export interface AccelerationStats {
  started: number;
  adopted: number;
  fallbacks: number;
  cacheHits: number;
  overlapMs: number;
}

export function newAccelerationStats(): AccelerationStats {
  return { started: 0, adopted: 0, fallbacks: 0, cacheHits: 0, overlapMs: 0 };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

type OpenAISpec = Extract<RunnerSpec, { type: "openai" }>;
type WireBody = Record<string, unknown>;
type CachedResponse = { result: ChatResult; deltas: string[]; expiresAt: number };

const RESPONSE_CACHE_TTL_MS = 300_000;
const RESPONSE_CACHE_ENTRIES = 128;
const responseCache = new Map<string, CachedResponse>();

function cacheNamespace(spec: OpenAISpec): string {
  return sha256Text(canonicalJson({
    baseUrl: spec.baseUrl.replace(/\/+$/, ""),
    model: spec.model,
    apiKey: spec.apiKey,
  }));
}

function responseCacheKey(spec: OpenAISpec, body: WireBody): string {
  return `${cacheNamespace(spec)}:${sha256Text(canonicalJson(body))}`;
}

function cloneResponse(response: CachedResponse): CachedResponse {
  return { result: structuredClone(response.result), deltas: [...response.deltas], expiresAt: response.expiresAt };
}

export function readOpenAIResponseCache(spec: OpenAISpec, body: WireBody): { result: ChatResult; deltas: string[] } | undefined {
  const key = responseCacheKey(spec, body);
  const cached = responseCache.get(key);
  if (!cached) return undefined;
  if (Date.now() >= cached.expiresAt) {
    responseCache.delete(key);
    return undefined;
  }
  responseCache.delete(key);
  responseCache.set(key, cached);
  const copy = cloneResponse(cached);
  copy.result.cacheHit = true;
  return { result: copy.result, deltas: copy.deltas };
}

export function writeOpenAIResponseCache(spec: OpenAISpec, body: WireBody, result: ChatResult, deltas: string[]): void {
  const key = responseCacheKey(spec, body);
  const storedResult = structuredClone(result);
  delete storedResult.cacheHit;
  responseCache.delete(key);
  responseCache.set(key, { result: storedResult, deltas: [...deltas], expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
  while (responseCache.size > RESPONSE_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
}

export function clearOpenAIResponseCache(spec?: OpenAISpec): void {
  if (!spec) {
    responseCache.clear();
    return;
  }
  const prefix = `${cacheNamespace(spec)}:`;
  for (const key of responseCache.keys()) if (key.startsWith(prefix)) responseCache.delete(key);
}
