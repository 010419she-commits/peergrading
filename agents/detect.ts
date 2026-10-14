// agents/detect.ts — 自动识别电脑上的 agent CLI 与本地/云端大模型
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import type { AgentInfo, RunnerSpec, Text } from "./types.ts";
import { clipboardAvailable } from "./relay.ts";
import { getProxyEnv, proxyEnvPrefix } from "./proxy.ts";

const L = (zh: string, en: string): Text => ({ zh, en });

const HOME = os.homedir();
const LMSTUDIO_URL = process.env.LMSTUDIO_URL ?? "http://localhost:1234";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

const EXTRA_BIN_DIRS = [
  path.join(HOME, ".local", "bin"),
  path.join(HOME, ".claude", "local"),
  path.join(HOME, ".npm-global", "bin"),
  path.join(HOME, ".lmstudio", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

type AgentDraft = Omit<AgentInfo, "auto"> & { auto?: boolean };

export function findBin(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...EXTRA_BIN_DIRS];
  // 也扫描所有 node 版本目录（nvm / 自定义安装）
  for (const d of [path.join(HOME, ".local"), path.join(HOME, ".nvm", "versions", "node")]) {
    try {
      for (const sub of fs.readdirSync(d)) dirs.push(path.join(d, sub, "bin"));
    } catch {}
  }
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

/** Claude 桌面版内置的 Claude Code 二进制（不在 PATH 上时作为后备） */
function findBundledClaude(): string | null {
  const root = path.join(HOME, "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = fs.readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const v of versions.reverse()) {
      for (const hash of fs.readdirSync(path.join(root, v))) {
        const bin = path.join(root, v, hash, "claude.app", "Contents", "MacOS", "claude");
        try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch {}
      }
    }
  } catch {}
  return null;
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) continue; // 避免嵌套会话的干扰
    env[k] = v;
  }
  for (const [k, v] of Object.entries(getProxyEnv())) if (!env[k]) env[k] = v;
  return env;
}

function run(bin: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: cleanEnv(), cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ stdout, stderr: String(e), code: -1 }); });
    child.stdin.end(stdin);
  });
}

function execJson(bin: string, args: string[], timeoutMs = 8000): Promise<any> {
  return new Promise((resolve) => {
    execFile(bin, args, { env: cleanEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function fetchJson(url: string, timeoutMs = 1500): Promise<any> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** 解析 stream-json / json 输出里的助手文本与模型名 */
function parseCliProbe(stdout: string): { text: string; model: string; isError: boolean; error: string } {
  let text = "", model = "", isError = false, error = "";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "assistant" && d.message) {
      if (d.message.model && d.message.model !== "<synthetic>") model = d.message.model;
      const t = (d.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (t) text = t;
    }
    if (d.type === "result") {
      if (typeof d.result === "string" && d.result) text = d.result;
      if (d.is_error) { isError = true; error = d.error?.message ?? d.result ?? "error"; }
    }
  }
  return { text, model, isError, error };
}

// ---------- 各类智能体的检测 ----------

async function detectClaudeCode(): Promise<AgentDraft | null> {
  const onPath = findBin("claude");
  const bin = onPath ?? findBundledClaude();
  if (!bin) return null;
  const settings = readJson(path.join(HOME, ".claude", "settings.json"));
  const configuredModel: string | undefined = process.env.ANTHROPIC_MODEL ?? settings?.model;

  const info: AgentDraft = {
    id: "claude-code",
    kind: "cli",
    title: "Claude Code",
    subtitle: onPath ? L("Anthropic 云端 · 使用你在终端登录的账号", "Anthropic cloud · uses the account you logged into in the terminal") : L("Anthropic 云端 · Claude 桌面版内置的命令行", "Anthropic cloud · CLI bundled with the Claude desktop app"),
    model: configuredModel ?? L("默认（Opus）", "default (Opus)"),
    local: false,
    status: "unverified",
    icon: "✴︎",
    runner: { type: "claude-code", bin, model: configuredModel },
  };

  // 优先用 `claude auth status --json`（不消耗额度）；旧版本不支持时再用一次真实请求探测
  const st = await run(bin, ["auth", "status", "--json"], "", 20_000);
  let loggedIn: boolean | null = null;
  try { const j = JSON.parse(st.stdout.slice(st.stdout.indexOf("{"))); if (typeof j.loggedIn === "boolean") loggedIn = j.loggedIn; } catch {}
  const px = proxyEnvPrefix();
  const notLoggedInHint = onPath ? L(`${px}claude auth login`, `${px}claude auth login`) : L(`npm install -g @anthropic-ai/claude-code && ${px}claude auth login`, `npm install -g @anthropic-ai/claude-code && ${px}claude auth login`);
  if (loggedIn === true) { info.status = "ready"; return info; }
  if (loggedIn === false) {
    info.status = "not_logged_in";
    info.statusDetail = L("命令行尚未登录（桌面版的登录不共享给命令行）。点「打开终端登录」，在浏览器里点一次授权即可", "The CLI is not logged in (the desktop app login is not shared). Press “Open Terminal to log in” and authorize once in the browser");
    info.hintCommand = notLoggedInHint;
    return info;
  }
  const r = await run(bin, ["-p", "--output-format", "stream-json", "--verbose", "--tools", "", "--max-turns", "1",
    "--system-prompt", "Reply with the single word OK."], "OK?", 60_000);
  const p = parseCliProbe(r.stdout);
  if (/not logged in/i.test(p.text) || /not logged in/i.test(r.stderr)) {
    info.status = "not_logged_in";
    info.statusDetail = L("命令行尚未登录（桌面版的登录不共享给命令行）", "The CLI is not logged in (the desktop app login is not shared with the CLI)");
    info.hintCommand = onPath ? L("claude   # 然后输入 /login", "claude   # then type /login") : L("npm install -g @anthropic-ai/claude-code && claude   # 然后输入 /login", "npm install -g @anthropic-ai/claude-code && claude   # then type /login");
  } else if (p.isError || r.code !== 0) {
    info.status = "error";
    info.statusDetail = (p.error || r.stderr || `exit ${r.code}`).slice(0, 300);
  } else {
    info.status = "ready";
    if (p.model) { info.model = p.model; info.runner = { ...info.runner, model: configuredModel } as RunnerSpec; }
  }
  return info;
}

async function detectQwenCloud(): Promise<AgentDraft | null> {
  const bin = findBin("qwen");
  if (!bin) return null;
  const settings = readJson(path.join(HOME, ".qwen", "settings.json"));
  const authType: string | undefined = settings?.security?.auth?.selectedType;
  const configuredModel: string | undefined = settings?.model?.name ?? process.env.OPENAI_MODEL;

  const info: AgentDraft = {
    id: "qwen-code",
    kind: "cli",
    title: "Qwen Code",
    subtitle: authType ? L(`云端 · 认证方式 ${authType}`, `Cloud · auth type ${authType}`) : L("云端 · 通义千问（Qwen OAuth）", "Cloud · Qwen (Qwen OAuth)"),
    model: configuredModel ?? L("默认（Qwen Coder）", "default (Qwen Coder)"),
    local: false,
    status: "unverified",
    icon: "Q",
    runner: { type: "qwen-code", bin, model: configuredModel },
  };

  if (!authType) {
    info.status = "not_logged_in";
    info.statusDetail = L("尚未在终端登录 Qwen Code", "Qwen Code has not been logged in from the terminal yet");
    info.hintCommand = L("qwen   # 首次启动时按提示完成登录", "qwen   # follow the login prompt on first launch");
    return info;
  }
  const r = await run(bin, ["--safe-mode", "--approval-mode", "plan", "--output-format", "stream-json",
    "--max-session-turns", "1", "--system-prompt", "Reply with the single word OK.", "-p", "OK?"], "", 60_000);
  const p = parseCliProbe(r.stdout);
  if (p.isError) {
    const msg = p.error;
    info.status = /auth|login|api key/i.test(msg) ? "not_logged_in" : "error";
    info.statusDetail = msg.slice(0, 300);
    if (info.status === "not_logged_in") info.hintCommand = L("qwen   # 首次启动时按提示完成登录", "qwen   # follow the login prompt on first launch");
  } else {
    info.status = "ready";
    if (p.model) info.model = p.model;
  }
  return info;
}

interface LocalServer { service: "lmstudio" | "ollama"; title: string; baseUrl: string; apiKey: string; up: boolean; models: string[]; loaded?: string; installed: boolean }

async function detectLmStudio(): Promise<LocalServer | null> {
  const lms = findBin("lms");
  const live = await fetchJson(`${LMSTUDIO_URL}/v1/models`);
  if (!lms && !live) return null;
  let models: string[] = [];
  if (live?.data) models = live.data.map((m: any) => m.id);
  if (models.length === 0 && lms) {
    const ls = await execJson(lms, ["ls", "--json"]);
    if (Array.isArray(ls)) models = ls.filter((m: any) => m.type === "llm").map((m: any) => m.modelKey);
  }
  models = models.filter((m) => !/embed/i.test(m));
  let loaded: string | undefined;
  if (lms) {
    const ps = await execJson(lms, ["ps", "--json"]);
    if (Array.isArray(ps)) loaded = ps.map((m: any) => m.identifier ?? m.modelKey).find((m: string) => m && !/embed/i.test(m));
  }
  return { service: "lmstudio", title: "LM Studio", baseUrl: `${LMSTUDIO_URL}/v1`, apiKey: "lm-studio", up: Boolean(live), models, loaded, installed: Boolean(lms) };
}

async function detectOllama(): Promise<LocalServer | null> {
  const ollama = findBin("ollama");
  const live = await fetchJson(`${OLLAMA_URL}/api/tags`);
  if (!ollama && !live) return null;
  let models: string[] = live?.models?.map((m: any) => m.name) ?? [];
  if (models.length === 0 && ollama) {
    const r = await run(ollama, ["list"], "", 5000);
    models = r.stdout.split("\n").slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean);
  }
  const ps = live ? await fetchJson(`${OLLAMA_URL}/api/ps`) : null;
  const loaded: string | undefined = ps?.models?.[0]?.name;
  return { service: "ollama", title: "Ollama", baseUrl: `${OLLAMA_URL}/v1`, apiKey: "ollama", up: Boolean(live), models, loaded, installed: Boolean(ollama) };
}

/** 每个本地服务一个条目（直连）+ 一个「Qwen Code 经由它」的条目；模型取当前已加载的，否则第一个 */
function localEntries(srv: LocalServer, qwenBin: string | null): AgentDraft[] {
  const icon = srv.service === "lmstudio" ? "▣" : "◌";
  if (srv.models.length === 0) {
    return [{
      id: `${srv.service}`, kind: "local", title: srv.title, subtitle: L("本地 · 尚未下载任何模型", "Local · no models downloaded yet"), model: "—",
      local: true, status: "error", statusDetail: L(`请先在 ${srv.title} 中下载一个模型`, `Download a model in ${srv.title} first`), service: srv.service,
      icon, runner: { type: "openai", baseUrl: srv.baseUrl, apiKey: srv.apiKey, model: "" },
    }];
  }
  const model = srv.loaded ?? srv.models[0];
  const status = srv.up ? "ready" : "server_off";
  const statusDetail = srv.up ? undefined : L("本地服务未运行，可在此一键启动", "Local server is not running; start it here with one click");
  const out: AgentDraft[] = [{
    id: `${srv.service}`, kind: "local", title: srv.title,
    subtitle: L("本地模型 · 直连 OpenAI 兼容接口", "Local model · direct OpenAI-compatible API"),
    model, local: true, status, statusDetail, service: srv.service, icon,
    runner: { type: "openai", baseUrl: srv.baseUrl, apiKey: srv.apiKey, model },
  }];
  if (qwenBin) {
    out.push({
      id: `qwen-code:${srv.service}`, kind: "cli", title: "Qwen Code",
      subtitle: L(`本地模型 · 通过 ${srv.title} 接入`, `Local model · via ${srv.title}`),
      model, local: true, status, statusDetail, service: srv.service, icon: "Q",
      runner: { type: "qwen-code", bin: qwenBin, model, openai: { baseUrl: srv.baseUrl, apiKey: srv.apiKey } },
    });
  }
  return out;
}

function detectGemini(): AgentDraft | null {
  const bin = findBin("gemini");
  if (!bin) return null;
  const settings = readJson(path.join(HOME, ".gemini", "settings.json"));
  const model = process.env.GEMINI_MODEL ?? settings?.model?.name ?? L("默认（Gemini）", "default (Gemini)");
  return { id: "gemini-cli", kind: "cli", title: "Gemini CLI", subtitle: L("Google 云端 · 命令行（实验性，未实测）", "Google cloud · CLI (experimental, untested)"), model, local: false,
    status: "unverified", icon: "G", runner: { type: "gemini-cli", bin, model: settings?.model?.name } };
}

/** Codex CLI：PATH 上的 codex，或 ChatGPT 桌面版内置的 codex-cli */
function findCodexBin(): { bin: string; bundled: boolean } | null {
  const onPath = findBin("codex");
  if (onPath) return { bin: onPath, bundled: false };
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    path.join(HOME, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex"),
  ];
  try {
    for (const rt of fs.readdirSync(path.join(HOME, ".cache", "codex-runtimes"))) {
      candidates.push(path.join(HOME, ".cache", "codex-runtimes", rt, "bin", "codex"));
    }
  } catch {}
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return { bin: c, bundled: true }; } catch {}
  }
  return null;
}

async function detectCodex(): Promise<AgentDraft | null> {
  const found = findCodexBin();
  if (!found) return null;
  let model: string | undefined;
  try {
    const toml = fs.readFileSync(path.join(HOME, ".codex", "config.toml"), "utf8");
    const m = toml.match(/^model\s*=\s*"([^"]+)"/m);
    if (m) model = m[1];
  } catch {}
  const auth = readJson(path.join(HOME, ".codex", "auth.json"));
  const authMode: string | undefined = auth?.auth_mode ?? (auth?.OPENAI_API_KEY ? "apikey" : undefined);

  const info: AgentDraft = {
    id: "codex", kind: "cli", icon: "C",
    title: "Codex",
    subtitle: found.bundled
      ? L(`OpenAI 云端 · ChatGPT 桌面版内置的 Codex 命令行${authMode === "chatgpt" ? "（已用 ChatGPT 账号登录）" : ""}`, `OpenAI cloud · Codex CLI bundled with the ChatGPT desktop app${authMode === "chatgpt" ? " (signed in with your ChatGPT account)" : ""}`)
      : L(`OpenAI 云端 · 命令行${authMode === "chatgpt" ? "（已用 ChatGPT 账号登录）" : ""}`, `OpenAI cloud · CLI${authMode === "chatgpt" ? " (signed in with your ChatGPT account)" : ""}`),
    model: model ?? L("默认（Codex）", "default (Codex)"),
    local: false, status: "unverified",
    runner: { type: "codex", bin: found.bin, model },
  };
  if (!authMode) {
    info.status = "not_logged_in";
    info.statusDetail = L("Codex 尚未登录", "Codex is not signed in yet");
    info.hintCommand = found.bundled ? L("打开 ChatGPT 应用 → Codex → 登录", "Open the ChatGPT app → Codex → sign in") : "codex login";
    return info;
  }
  const r = await run(found.bin, ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-c", "notify=[]",
    "Reply with the single word OK"], "", 90_000);
  let text = "", err = "";
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === "item.completed" && d.item?.type === "agent_message") text = d.item.text ?? "";
      if (d.type === "item.completed" && d.item?.type === "error" && !/deprecated/i.test(d.item.message ?? "")) err = d.item.message ?? "";
      if (d.type === "error") err = d.message ?? JSON.stringify(d);
    } catch {}
  }
  if (text) info.status = "ready";
  else {
    const msg = err || r.stderr || `exit ${r.code}`;
    info.status = /login|auth|sign in|unauthorized|401/i.test(msg) ? "not_logged_in" : "error";
    info.statusDetail = msg.slice(0, 300);
    if (info.status === "not_logged_in") info.hintCommand = found.bundled ? L("打开 ChatGPT 应用 → Codex → 登录", "Open the ChatGPT app → Codex → sign in") : "codex login";
  }
  return info;
}

function detectAnthropicApi(): AgentDraft | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
  return { id: "anthropic-api", kind: "api", title: "Anthropic API", subtitle: L("云端 · 使用环境变量中的 API Key 直连", "Cloud · direct via ANTHROPIC_API_KEY"), model, local: false,
    status: "ready", icon: "✴︎", runner: { type: "anthropic", model, effort: "high" } };
}

/** 网页中转：不需要登录任何命令行，把消息交给你正在用的桌面应用 */
function relayEntries(): AgentDraft[] {
  const out: AgentDraft[] = [];
  if (clipboardAvailable()) {
    out.push({
      id: "relay:clipboard", kind: "relay", icon: "⧉",
      title: L("剪贴板中转", "Clipboard relay"),
      subtitle: L("任意桌面应用（Claude 桌面版、Qwen Code 等）· 网页自动复制要发的内容，你粘贴发送；复制回答后网页自动接收", "Any desktop app (Claude desktop, Qwen Code, …) · the page copies the message for you; copy the app's answer and the page picks it up"),
      model: L("由你粘贴到的应用决定", "whichever app you paste into"),
      local: false, status: "ready", runner: { type: "relay", mode: "clipboard" },
    });
  }
  out.push({
    id: "relay:manual", kind: "relay", icon: "✎",
    title: L("手动中转", "Manual relay"),
    subtitle: L("任意桌面应用 · 复制网页上的内容发给它，再把回答粘贴回网页", "Any desktop app · copy the text from the page, paste the app's answer back"),
    model: L("由你粘贴到的应用决定", "whichever app you paste into"),
    local: false, status: "ready", runner: { type: "relay", mode: "manual" },
  });
  return out;
}

/** Kimi（API 直连，全自动）：使用环境里已有的 KIMI_API_KEY / MOONSHOT_API_KEY */
const KIMI_URL = process.env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1";
const KIMI_PREFERRED = ["kimi-k2.7-code", "kimi-k2.7", "kimi-k2.6-code", "kimi-k2.6", "kimi-k2.5", "kimi-k2-thinking", "kimi-k2-0905-preview", "kimi-k2-turbo-preview", "kimi-latest"];

async function detectKimiApi(): Promise<AgentDraft | null> {
  const key = process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
  if (!key) return null;
  const info: AgentDraft = {
    id: "kimi-api", kind: "api", icon: "K",
    title: "Kimi Code",
    subtitle: L("Moonshot 云端 · 通过你环境里的 KIMI_API_KEY 直连", "Moonshot cloud · direct via your KIMI_API_KEY"),
    model: process.env.KIMI_MODEL ?? "kimi-k2-0905-preview", local: false, status: "unverified",
    runner: { type: "openai", baseUrl: KIMI_URL, apiKey: key, model: process.env.KIMI_MODEL ?? "kimi-k2-0905-preview" },
  };
  try {
    const res = await fetch(`${KIMI_URL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401) { info.status = "error"; info.statusDetail = L("KIMI_API_KEY 无效或已过期", "KIMI_API_KEY is invalid or expired"); return info; }
    const j: any = await res.json();
    const ids: string[] = (j.data ?? []).map((m: any) => m.id);
    if (ids.length) {
      const pick = process.env.KIMI_MODEL ?? KIMI_PREFERRED.find((m) => ids.includes(m)) ?? ids[0];
      info.model = pick; info.runner = { ...info.runner, model: pick } as RunnerSpec; info.status = "ready";
    }
  } catch (e: any) {
    info.status = "error"; info.statusDetail = L(`无法连接 ${KIMI_URL}：${e?.message ?? e}`, `Cannot reach ${KIMI_URL}: ${e?.message ?? e}`);
  }
  return info;
}

/** 桌面版 agent 应用：没有命令行，用剪贴板中转接入（一键发送会把它切到前台） */
const DESKTOP_AGENT_APPS: { app: string; title: string; zh: string; en: string; icon: string }[] = [
  { app: "Kimi Code", title: "Kimi Code", zh: "Moonshot 云端 · 桌面应用", en: "Moonshot cloud · desktop app", icon: "K" },
  { app: "Kimi", title: "Kimi", zh: "Moonshot 云端 · 桌面应用", en: "Moonshot cloud · desktop app", icon: "K" },
  { app: "Claude", title: "Claude（桌面版）", zh: "Anthropic 云端 · 桌面应用", en: "Anthropic cloud · desktop app", icon: "✴︎" },
  { app: "ChatGPT", title: "ChatGPT / Codex（桌面版）", zh: "OpenAI 云端 · 桌面应用", en: "OpenAI cloud · desktop app", icon: "C" },
  { app: "Qwen Code", title: "Qwen Code（桌面版）", zh: "阿里云端 · 桌面应用", en: "Alibaba cloud · desktop app", icon: "Q" },
  { app: "Cursor", title: "Cursor", zh: "桌面应用（编辑器内的 Agent）", en: "Desktop app (editor agent)", icon: "▸" },
  { app: "Windsurf", title: "Windsurf", zh: "桌面应用（编辑器内的 Agent）", en: "Desktop app (editor agent)", icon: "W" },
  { app: "Trae", title: "Trae", zh: "桌面应用（编辑器内的 Agent）", en: "Desktop app (editor agent)", icon: "T" },
  { app: "Trae CN", title: "Trae CN", zh: "桌面应用（编辑器内的 Agent）", en: "Desktop app (editor agent)", icon: "T" },
  { app: "Kiro", title: "Kiro", zh: "桌面应用（编辑器内的 Agent）", en: "Desktop app (editor agent)", icon: "K" },
  { app: "Qoder", title: "Qoder", zh: "桌面应用（编辑器内的 Agent）", en: "Desktop app (editor agent)", icon: "Q" },
  { app: "CodeBuddy", title: "CodeBuddy", zh: "桌面应用（编辑器内的 Agent）", en: "Desktop app (editor agent)", icon: "B" },
  { app: "Antigravity", title: "Antigravity", zh: "Google · 桌面应用", en: "Google · desktop app", icon: "A" },
  { app: "Zed", title: "Zed", zh: "桌面应用（编辑器内的 Agent）", en: "Desktop app (editor agent)", icon: "Z" },
  { app: "Visual Studio Code", title: "VS Code（Copilot）", zh: "桌面应用（Copilot Chat）", en: "Desktop app (Copilot Chat)", icon: "V" },
];

function detectDesktopApps(): AgentDraft[] {
  const out: AgentDraft[] = [];
  const dirs = ["/Applications", path.join(HOME, "Applications")];
  for (const a of DESKTOP_AGENT_APPS) {
    const found = dirs.some((d) => fs.existsSync(path.join(d, `${a.app}.app`)));
    if (!found) continue;
    out.push({
      id: `app:${a.app}`, kind: "relay", icon: a.icon, title: /桌面版|\(/.test(a.title) ? a.title : `${a.title}（桌面应用）`,
      subtitle: L(`${a.zh} · 需要你在应用里粘贴、复制回答；一键发送会把它切到前台`, `${a.en} · you paste and copy in the app; one-click send brings it to the front`),
      model: "—", local: false, status: "ready",
      runner: { type: "relay", mode: clipboardAvailable() ? "clipboard" : "manual", app: a.app },
    });
  }
  return out;
}

/** 其他命令行 agent：按可执行文件存在与否列出；调用参数取自各自文档，标为实验性 */
const GENERIC_CLIS: { bin: string; title: string; zh: string; en: string; icon: string; args: string[]; promptVia: "stdin" | "arg"; parse: "jsonl" | "text" }[] = [
  { bin: "kimi", title: "Kimi Code CLI", zh: "Moonshot 云端 · 命令行（实验性）", en: "Moonshot cloud · CLI (experimental)", icon: "K", args: ["--print"], promptVia: "stdin", parse: "text" },
  { bin: "opencode", title: "OpenCode", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "O", args: ["run"], promptVia: "arg", parse: "text" },
  { bin: "cursor-agent", title: "Cursor Agent CLI", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "▸", args: ["-p", "--output-format", "text"], promptVia: "arg", parse: "text" },
  { bin: "copilot", title: "GitHub Copilot CLI", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "V", args: ["-p"], promptVia: "arg", parse: "text" },
  { bin: "amp", title: "Amp", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "A", args: ["-x"], promptVia: "arg", parse: "text" },
  { bin: "droid", title: "Factory Droid", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "D", args: ["exec"], promptVia: "arg", parse: "text" },
  { bin: "crush", title: "Crush", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "C", args: ["run"], promptVia: "arg", parse: "text" },
  { bin: "goose", title: "Goose", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "G", args: ["run", "-t"], promptVia: "arg", parse: "text" },
  { bin: "auggie", title: "Augment (auggie)", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "A", args: ["--print"], promptVia: "arg", parse: "text" },
  { bin: "iflow", title: "iFlow CLI", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "i", args: ["-p"], promptVia: "arg", parse: "text" },
  { bin: "codebuddy", title: "CodeBuddy CLI", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "B", args: ["-p"], promptVia: "arg", parse: "text" },
  { bin: "aider", title: "Aider", zh: "命令行（实验性）", en: "CLI (experimental)", icon: "a", args: ["--no-git", "--yes-always", "--message"], promptVia: "arg", parse: "text" },
];

function detectGenericClis(): AgentDraft[] {
  const out: AgentDraft[] = [];
  for (const c of GENERIC_CLIS) {
    const bin = findBin(c.bin);
    if (!bin) continue;
    out.push({
      id: `cli:${c.bin}`, kind: "cli", icon: c.icon, title: c.title, subtitle: L(c.zh, c.en), model: "—", local: false, status: "unverified",
      runner: { type: "generic", bin, args: c.args, promptVia: c.promptVia, parse: c.parse },
    });
  }
  return out;
}

// ---------- 汇总 + 缓存 ----------

let cache: { at: number; agents: AgentInfo[] } | null = null;
let inflight: Promise<AgentInfo[]> | null = null;
const TTL = 5 * 60 * 1000;
const SCAN_MODELS = process.env.SCAN_MODELS === "1";   // 默认只扫描 agent，不扫描本地/云端大模型

export async function detectAgents(refresh = false): Promise<AgentInfo[]> {
  if (!refresh && cache && Date.now() - cache.at < TTL) return cache.agents;
  if (inflight) return inflight;
  inflight = (async () => {
    const qwenBin = findBin("qwen");
    const [claude, qwen, cdx, kimiApi, lm, ollama] = await Promise.all([
      detectClaudeCode(), detectQwenCloud(), detectCodex(), detectKimiApi(),
      SCAN_MODELS ? detectLmStudio() : Promise.resolve(null), SCAN_MODELS ? detectOllama() : Promise.resolve(null),
    ]);
    const agents: AgentInfo[] = [] as any;
    if (claude) agents.push(claude as AgentInfo);
    if (cdx) agents.push(cdx);
    if (qwen) agents.push(qwen);
    if (kimiApi) agents.push(kimiApi);
    const gem = detectGemini(); if (gem) agents.push(gem);
    agents.push(...detectGenericClis());
    agents.push(...detectDesktopApps());
    if (SCAN_MODELS) {
      const api = detectAnthropicApi(); if (api) agents.push(api);
      if (lm) agents.push(...localEntries(lm, qwenBin));
      if (ollama) agents.push(...localEntries(ollama, qwenBin));
    }
    agents.push(...relayEntries());
    for (const a of agents) a.auto = a.kind !== "relay";
    // 全自动的排前面
    agents.sort((x, y) => Number(y.auto) - Number(x.auto));
    cache = { at: Date.now(), agents };
    inflight = null;
    return agents;
  })();
  return inflight;
}

/** 一键登录：返回要在终端里执行的命令。Claude Code 若支持 `auth login` 子命令就直接用，否则进入交互界面并提示输入 /login */
export async function loginCommandFor(id: string): Promise<{ command: string; note: "none" | "type_login" | "follow_prompt" } | null> {
  const a = getCachedAgent(id);
  if (!a) return null;
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  if (a.runner.type === "claude-code") {
    const r = await run(a.runner.bin, ["auth", "--help"], "", 15_000);
    const hasAuth = r.code === 0 && /login/i.test(r.stdout);
    // 国内网络直连 Anthropic 会 403，登录命令带上系统代理
    return hasAuth ? { command: `${proxyEnvPrefix()}${q(a.runner.bin)} auth login`, note: "none" } : { command: `${proxyEnvPrefix()}${q(a.runner.bin)}`, note: "type_login" };
  }
  if (a.runner.type === "qwen-code") return { command: q(a.runner.bin), note: "follow_prompt" };
  if (a.runner.type === "codex") return { command: `${proxyEnvPrefix()}${q(a.runner.bin)} login`, note: "none" };
  if (a.runner.type === "generic") return { command: q(a.runner.bin), note: "follow_prompt" };
  return null;
}

export function getCachedAgent(id: string): AgentInfo | undefined {
  return cache?.agents.find((a) => a.id === id);
}

/** 一键启动本地模型服务 */
export async function startService(service: "lmstudio" | "ollama"): Promise<{ ok: boolean; message: string }> {
  if (service === "lmstudio") {
    const lms = findBin("lms");
    if (!lms) return { ok: false, message: "未找到 lms 命令，请先安装 LM Studio" };
    const r = await run(lms, ["server", "start"], "", 20_000);
    const up = await fetchJson(`${LMSTUDIO_URL}/v1/models`, 3000);
    cache = null;
    return up ? { ok: true, message: "LM Studio 服务已启动" } : { ok: false, message: (r.stderr || r.stdout).slice(0, 300) };
  }
  const ollama = findBin("ollama");
  if (!ollama) return { ok: false, message: "未找到 ollama 命令" };
  const child = spawn(ollama, ["serve"], { env: cleanEnv(), detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await fetchJson(`${OLLAMA_URL}/api/tags`, 1000)) { cache = null; return { ok: true, message: "Ollama 服务已启动" }; }
  }
  return { ok: false, message: "Ollama 启动超时" };
}
