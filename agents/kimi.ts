// Kimi Code 2.x: each turn owns a disposable config and an explicit tool profile.
// The CLI runs outside the repository so project MCP servers/plugins cannot start.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import type { ChatRequest } from "./types.ts";
import { stripNestedClaudeEnv } from "./launch.ts";
import { getProxyEnv } from "./proxy.ts";

export interface KimiLaunchFiles {
  agentFile: string;
  skillsDir: string;
  repositoryDir?: string;
}
export interface KimiLaunch extends KimiLaunchFiles {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const kimiHome = (env: NodeJS.ProcessEnv) => env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const credentialsPresent = async (home: string, key: string) => {
  const files = credentialPaths(home, key);
  for (const file of files) if (await fs.stat(file).then((s) => s.isFile(), () => false)) return true;
  return false;
};
function credentialPaths(home: string, key: string): string[] {
  // Only local file-backed Kimi credentials are supported; never follow a path out of its data root.
  if (!key || path.isAbsolute(key) || key.includes("\\") || key.split("/").some((v) => !v || v === "." || v === "..")) {
    throw new Error("Kimi Code 认证引用无效，请重新运行 kimi login");
  }
  return [...new Set([path.join(home, key), path.join(home, "credentials", `${path.basename(key)}.json`)])];
}

async function readProfile(env: NodeJS.ProcessEnv, override?: string) {
  const home = kimiHome(env);
  let data: Record<string, any> = {};
  try { data = parse(await fs.readFile(path.join(home, "config.toml"), "utf8")); }
  catch (e: any) {
    if (e.code !== "ENOENT") throw new Error("无法读取 Kimi Code 配置，请运行 kimi doctor 检查（配置内容未写入日志）");
  }
  const alias = override || data.default_model;
  const model = alias && isObject(data.models?.[alias]) ? data.models[alias] : undefined;
  const provider = model && isObject(data.providers?.[model.provider]) ? data.providers[model.provider] : undefined;
  if (model && provider) return { home, alias, model, provider, thinking: data.thinking };
  if (override || alias) throw new Error("Kimi Code 默认模型未配置或不存在，请在 Kimi Code 中选择模型");
  // Explicit environment-based API access, separate from the persisted Kimi Code OAuth account.
  const key = env.KIMI_API_KEY || env.MOONSHOT_API_KEY;
  if (!key) throw new Error("Kimi Code 尚未登录，请运行 kimi login");
  const name = env.KIMI_MODEL || "kimi-k2.5";
  return { home, alias: "peergrading/default", model: { provider: "peergrading", model: name, max_context_size: 262144, capabilities: ["thinking", "tool_use"] },
    provider: { type: "kimi", base_url: env.KIMI_BASE_URL || "https://api.moonshot.cn/v1", api_key_env: env.KIMI_API_KEY ? "KIMI_API_KEY" : "MOONSHOT_API_KEY" }, thinking: undefined };
}

export async function kimiAccountSummary(env: NodeJS.ProcessEnv = process.env): Promise<{ ready: boolean; model: string }> {
  const p = await readProfile(env);
  const apiKey = typeof p.provider.api_key === "string" && !!p.provider.api_key
    || typeof p.provider.api_key_env === "string" && !!env[p.provider.api_key_env]
    || ["KIMI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].some((k) => typeof p.provider.env?.[k] === "string" && !!p.provider.env[k]);
  const oauth = p.provider.oauth;
  const ready = !!apiKey || isObject(oauth) && oauth.storage === "file" && typeof oauth.key === "string" && await credentialsPresent(p.home, oauth.key);
  return { ready, model: p.alias };
}

export function kimiAgentDefinition(req: Pick<ChatRequest, "repositoryAccess" | "system" | "turns" | "cwd">): string {
  const tools = req.repositoryAccess === "write" ? ["Read", "Glob", "Grep", "Edit", "Write"]
    : req.repositoryAccess ? ["Read", "Glob", "Grep"] : [];
  const header = ["---", "name: peergrading-turn", "description: Execute one PeerGrading collaboration turn", `tools: [${tools.join(", ")}]`, "subagents: []", "---"];
  const scope = req.repositoryAccess ? `The only project for this turn is ${JSON.stringify(path.resolve(req.cwd))}. Use absolute file paths inside that project. Do not modify Git metadata or access other projects. Tests and Git commits are managed by PeerGrading, so do not attempt shell commands.\n` : "This is a text-only turn. No file, command, network, or subagent tools are enabled.\n";
  // Do not embed ${base_prompt}, ${skills}, or ${plugin_sections}: that would inject
  // the user's/project's plugin instructions into our deliberately complete profile.
  // Kimi templates ${...} inside agent bodies. Encode dollar signs as JSON escapes
  // so literal code/prompt content cannot expand ${base_prompt} or other injections.
  const payload = JSON.stringify({ system: req.system, messages: req.turns }, null, 2).replace(/\$/g, "\\u0024");
  return `${header.join("\n")}\n\n${scope}\nThe following JSON contains your system instructions and chronological conversation. Decode JSON string escapes normally; answer the latest user message.\n\n${payload}\n`;
}

export async function prepareKimiLaunch(req: ChatRequest, sourceEnv: NodeJS.ProcessEnv = process.env, modelOverride?: string): Promise<KimiLaunch> {
  const p = await readProfile(sourceEnv, modelOverride);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "peergrading-kimi-"));
  const cleanup = () => fs.rm(root, { recursive: true, force: true });
  try {
    await fs.chmod(root, 0o700);
    const home = path.join(root, "runtime"), cwd = path.join(root, "workspace"), skillsDir = path.join(root, "skills");
    for (const dir of [home, cwd, skillsDir]) await fs.mkdir(dir, { mode: 0o700 });
    const env = stripNestedClaudeEnv({ ...sourceEnv });
    for (const [k, v] of Object.entries(getProxyEnv())) if (!env[k]) env[k] = v;
    // Prevent ambient model overrides from silently bypassing the selected account/config.
    for (const k of Object.keys(env)) if (k.startsWith("KIMI_MODEL_")) delete env[k];
    Object.assign(env, { KIMI_CODE_HOME: home, KIMI_DISABLE_TELEMETRY: "1", KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CODE_WATCH: "false", KIMI_CODE_BUILTIN_PRODUCT_SKILLS: "false", KIMI_LOOP_MAX_STEPS_PER_TURN: "40", KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: "2" });
    const provider: Record<string, any> = {};
    for (const key of ["type", "base_url", "api_key_env"]) if (typeof p.provider[key] === "string") provider[key] = p.provider[key];
    const configuredKey = p.provider.api_key || ["KIMI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].map((k) => p.provider.env?.[k]).find((v) => typeof v === "string" && v);
    if (configuredKey) {
      // Persist no API keys in temporary TOML/agent files; only this child's environment receives it.
      env.PEERGRADING_KIMI_PROVIDER_API_KEY = configuredKey;
      provider.api_key_env = "PEERGRADING_KIMI_PROVIDER_API_KEY";
    } else if (isObject(p.provider.oauth) && p.provider.oauth.storage === "file" && typeof p.provider.oauth.key === "string") {
      const key = p.provider.oauth.key;
      provider.oauth = { storage: "file", key };
      delete provider.api_key_env;
      let copied = false;
      for (const src of credentialPaths(p.home, key)) {
        if (!await fs.stat(src).then((s) => s.isFile(), () => false)) continue;
        const dest = path.join(home, path.relative(p.home, src));
        await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        await fs.copyFile(src, dest); await fs.chmod(dest, 0o600); copied = true;
      }
      if (!copied) throw new Error("Kimi Code 认证文件不存在，请运行 kimi login");
    }
    const model: Record<string, any> = { provider: "peergrading" };
    for (const key of ["model", "max_context_size", "capabilities", "display_name", "support_efforts", "default_effort"]) if (p.model[key] !== undefined) model[key] = p.model[key];
    const config: Record<string, any> = { default_model: p.alias, telemetry: false,
      providers: { peergrading: provider }, models: { [p.alias]: model }, hooks: [], builtin_product_skills: false, loop_control: { max_steps_per_turn: 40, max_attempts_per_step: 2 },
      watch: { enabled: false }, background: { keep_alive_on_exit: false, print_background_mode: "exit" },
      // Defense in depth: this switch intersects with the custom agent's exact allowlist.
      tools: { enabled: req.repositoryAccess === "write" ? ["Read", "Glob", "Grep", "Edit", "Write"] : req.repositoryAccess ? ["Read", "Glob", "Grep"] : ["Read"] },
    };
    if (isObject(p.thinking)) {
      const thinking: Record<string, any> = {};
      for (const key of ["enabled", "effort", "keep"]) if (p.thinking[key] !== undefined) thinking[key] = p.thinking[key];
      config.thinking = thinking;
    }
    await fs.writeFile(path.join(home, "config.toml"), stringify(config), { mode: 0o600 });
    const agentFile = path.join(root, "peergrading-turn.md");
    await fs.writeFile(agentFile, kimiAgentDefinition(req), { mode: 0o600 });
    return { agentFile, skillsDir, repositoryDir: req.repositoryAccess ? path.resolve(req.cwd) : undefined, cwd, env, cleanup };
  } catch (e) { await cleanup(); throw e; }
}
