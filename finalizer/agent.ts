// finalizer/agent.ts — 把项目里的任一全自动 agent 适配成收尾 Agent 的模型接口
import type { Agent } from "./types.ts";
import type { AgentInfo } from "../agents/types.ts";
import { createBackend } from "../agents/backends.ts";

/** 模型偶尔会把 JSON 包在围栏里或前后加说明；只取第一个顶层 JSON 对象。原稿要求严格 JSON，这里仅做容错剥离，不改内容 */
export function stripToJson(text: string): string {
  const t = text.trim();
  if (t.startsWith("{") && t.endsWith("}")) return t;
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}

export function makeAgent(info: AgentInfo, cwd: string): Agent {
  if (info.kind === "relay") throw new Error("收尾 Agent 需要能自动调用的 agent（命令行或接口直连）");
  return {
    async complete({ system, user, signal }) {
      const backend = createBackend(info.runner, { emit: () => {} });
      const res = await backend.chat({ system, turns: [{ role: "user", text: user }], lang: "zh", cwd, signal, onDelta: () => {} });
      return stripToJson(res.text);
    },
  };
}
