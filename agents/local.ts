import type { AgentInfo, AgentStatus, Text } from "./types.ts";
import { normalizeLocalBaseUrl as normalizeConnectionBaseUrl, type LocalModelConnection } from "./local-connections.ts";

const L = (zh: string, en: string): Text => ({ zh, en });
type Env = Record<string, string | undefined>;

export interface LocalOpenAIEndpoint {
  baseUrl: string;
  model?: string;
  apiKey: string;
  source: "qwen" | "ninfer" | "strata" | "compatible" | "connection";
  name?: string;
  connectionId?: string;
  configured: boolean;
}

/** Automatic discovery is limited to HTTP(S) loopback endpoints, without URL credentials. */
export function normalizeLocalBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (host !== "localhost" && host !== "[::1]" && !/^127\.\d+\.\d+\.\d+$/.test(host)) return null;
    const pathname = url.pathname.replace(/\/+$/, "") || "/v1";
    return `${url.origin}${pathname}`;
  } catch { return null; }
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Read only the selected OpenAI provider, never a global cloud OPENAI_API_KEY. */
export function configuredQwenLocalEndpoint(settings: any, _env: Env = {}): LocalOpenAIEndpoint | null {
  const auth = string(settings?.security?.auth?.selectedType);
  if (auth && auth !== "openai") return null;
  const model = string(settings?.model?.name);
  const providers: any[] = Array.isArray(settings?.modelProviders?.openai) ? settings.modelProviders.openai : [];
  const selected = model ? providers.find((provider) => string(provider?.id) === model || string(provider?.model) === model) : undefined;
  const configuredUrl = string(settings?.model?.baseUrl);
  const baseUrl = normalizeLocalBaseUrl(configuredUrl ?? selected?.baseUrl);
  if (!baseUrl) return null;
  const sameEndpoint = providers.filter((provider) => normalizeLocalBaseUrl(provider?.baseUrl) === baseUrl);
  const provider = selected
    ? (normalizeLocalBaseUrl(selected.baseUrl) === baseUrl ? selected : undefined)
    : sameEndpoint.length === 1 ? sameEndpoint[0] : undefined;
  // A key on model belongs to model.baseUrl; provider keys require an exact endpoint match.
  const apiKey = (configuredUrl ? string(settings?.model?.apiKey) : undefined) ?? string(provider?.apiKey) ?? "";
  return { baseUrl, model, apiKey, source: "qwen", configured: true };
}

export interface DetectLocalOpenAIOptions {
  settings?: unknown;
  env?: Env;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  connections?: LocalModelConnection[];
}

function entry(endpoint: LocalOpenAIEndpoint, model: string, status: AgentStatus, statusDetail?: Text): AgentInfo {
  const title = endpoint.name ?? (endpoint.source === "ninfer" ? "NInfer" : endpoint.source === "strata" ? "Strata"
    : endpoint.source === "compatible" ? "NInfer / Strata" : L("本地模型（Qwen 配置）", "Local model (Qwen settings)"));
  return {
    id: endpoint.connectionId
      ? `local-openai:connection:${encodeURIComponent(endpoint.connectionId)}:${encodeURIComponent(endpoint.baseUrl)}:${encodeURIComponent(model)}`
      : `local-openai:${encodeURIComponent(endpoint.baseUrl)}:${encodeURIComponent(model)}`,
    kind: "local", title,
    subtitle: L(`本地 · OpenAI 兼容接口 · ${endpoint.baseUrl}`, `Local · OpenAI-compatible API · ${endpoint.baseUrl}`),
    model: model || "—", local: true, deployment: "local", auto: true, repository: false, status, statusDetail, icon: "◈",
    runner: { type: "openai", baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model },
  };
}

/** GET /models only: discovery never generates text, starts a process or follows redirects. */
export async function detectLocalOpenAIAgents(options: DetectLocalOpenAIOptions = {}): Promise<AgentInfo[]> {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const endpoints = new Map<string, LocalOpenAIEndpoint>();
  const qwen = configuredQwenLocalEndpoint(options.settings, env);
  if (qwen) endpoints.set(qwen.baseUrl, qwen);
  const configuredNinfer = string(env.NINFER_URL), configuredStrata = string(env.STRATA_URL);
  if (!configuredNinfer && !configuredStrata) {
    const baseUrl = "http://127.0.0.1:8080/v1";
    const existing = endpoints.get(baseUrl);
    endpoints.set(baseUrl, existing ? {
      ...existing, apiKey: string(env.NINFER_API_KEY) ?? string(env.STRATA_API_KEY) ?? existing.apiKey,
    } : {
      baseUrl, apiKey: string(env.NINFER_API_KEY) ?? string(env.STRATA_API_KEY) ?? "", source: "compatible", configured: false,
    });
  }
  for (const [value, key, source] of [
    [configuredNinfer, env.NINFER_API_KEY, "ninfer"], [configuredStrata, env.STRATA_API_KEY, "strata"],
  ] as const) {
    const baseUrl = normalizeLocalBaseUrl(value);
    if (!baseUrl) continue;
    const existing = endpoints.get(baseUrl);
    endpoints.set(baseUrl, { baseUrl, model: existing?.model, apiKey: string(key) ?? existing?.apiKey ?? "", source, configured: true });
  }
  const profiles = new Map<string, LocalOpenAIEndpoint>();
  for (const connection of options.connections ?? []) {
    let baseUrl: string;
    try { baseUrl = normalizeConnectionBaseUrl(connection.baseUrl); } catch { continue; }
    // Explicit profiles replace automatic guesses, while each saved identity keeps its own credentials.
    endpoints.delete(baseUrl);
    profiles.set(connection.id, {
      baseUrl, model: string(connection.model),
      apiKey: string(connection.apiKey) ?? "", source: "connection", name: connection.name, connectionId: connection.id, configured: true,
    });
  }
  const results = await Promise.all([...endpoints.values(), ...profiles.values()].map(async (endpoint): Promise<AgentInfo[]> => {
    const failed = (status: AgentStatus, detail: Text) => endpoint.configured ? [entry(endpoint, endpoint.model ?? "", status, detail)] : [];
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;
      const response = await fetcher(`${endpoint.baseUrl}/models`, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 401 || response.status === 403) {
        return [entry(endpoint, endpoint.model ?? "", "not_logged_in", L(
          "本地接口要求 API Key，请检查所选本地服务的密钥配置。", "The local endpoint requires an API key. Check the selected local service's key configuration.",
        ))];
      }
      if (!response.ok) return failed("error", L(`本地模型接口暂不可用（HTTP ${response.status}）。`, `The local model endpoint is unavailable (HTTP ${response.status}).`));
      let body: any;
      try { body = await response.json(); }
      catch { return failed("error", L("本地模型接口没有返回有效的模型列表。", "The local model endpoint did not return a valid model list.")); }
      const models: string[] = Array.isArray(body?.data)
        ? [...new Set<string>(body.data.map((model: any) => string(model?.id)).filter((id: string | undefined): id is string => Boolean(id)))] : [];
      if (!models.length) return failed("error", L("本地接口没有返回可用模型，请先在推理服务中加载模型。", "The local endpoint returned no models. Load a model in the inference service first."));
      if (endpoint.source === "connection" && endpoint.model) {
        return models.includes(endpoint.model) ? [entry(endpoint, endpoint.model, "ready")] : failed("error", L(
          "填写的模型未在此接口中找到。请核对模型 ID，或清空模型字段以自动发现。",
          "The specified model was not advertised by this endpoint. Check its model ID, or clear the model field to discover available models.",
        ));
      }
      if (endpoint.source === "compatible" || endpoint.source === "qwen") {
        try {
          const healthUrl = new URL(endpoint.baseUrl);
          healthUrl.pathname = "/health";
          healthUrl.search = "";
          healthUrl.hash = "";
          const healthResponse = await fetcher(healthUrl.href, { headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
          if (healthResponse.ok) {
            const health = await healthResponse.json();
            const service = string(health?.service)?.toLowerCase();
            if (service === "strata" || service === "ninfer") endpoint = { ...endpoint, source: service };
          }
        } catch {}
      }
      return models.map((model) => entry(endpoint, model, "ready"));
    } catch {
      return failed("server_off", L(
        `无法连接本地模型接口 ${endpoint.baseUrl}。请先启动推理服务，再点击刷新。`,
        `Cannot reach the local model endpoint ${endpoint.baseUrl}. Start the inference service, then refresh.`,
      ));
    }
  }));
  return results.flat();
}
