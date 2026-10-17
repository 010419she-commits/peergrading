import type { AgentInfo } from "./types.ts";
import type { ApiConnection } from "./api-connections.ts";

/** Explicit saved profiles do not probe a provider or incur a generation charge. */
export function savedApiAgents(connections: ApiConnection[]): AgentInfo[] {
  const icons: Record<string, string> = { kimi: "K", deepseek: "D", qwen: "Q", glm: "Z", doubao: "豆", custom: "☁" };
  return connections.map((connection) => ({
    id: `cloud-api:${connection.id}`, kind: "api", title: connection.name,
    subtitle: { zh: `云端 API · ${new URL(connection.baseUrl).host}`, en: `Cloud API · ${new URL(connection.baseUrl).host}` },
    model: connection.model, local: false, deployment: "cloud", auto: true, repository: false, status: "unverified",
    statusDetail: { zh: "已保存配置；开始协作时验证密钥和模型。", en: "Configuration saved; credentials and model are verified when you start a collaboration." },
    icon: icons[connection.provider] || "☁",
    runner: { type: "openai", baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model },
  }));
}
