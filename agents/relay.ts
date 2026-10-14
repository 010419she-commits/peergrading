// agents/relay.ts — 网页中转：把消息交给你手上的任意桌面应用，再把它的回答收回来
import { execFile } from "node:child_process";
import type { Backend, ChatRequest, ChatResult } from "./types.ts";

export type RelayMode = "manual" | "clipboard";

export interface RelayContext {
  emit: (ev: any) => void;
}

type Pending = { resolve: (text: string) => void; own: Set<string> };
const pending = new Map<string, Pending>();

/** 一键发送时登记“这是我们放进剪贴板的内容”，防止被当成回复 */
export function markOwnClipboardText(requestId: string, text: string) {
  pending.get(requestId)?.own.add(text);
}

/** 由 POST /api/relay/reply 调用 */
export function submitRelayReply(requestId: string, text: string): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  p.own.add(text);
  p.resolve(text);
  return true;
}

/** 用户说“这不是回答”：以后忽略这段剪贴板内容 */
export function ignoreRelayText(requestId: string, text: string): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  p.own.add(text);
  return true;
}

// pbcopy/pbpaste 按 locale 解码；若环境没有 UTF-8 locale，中文会丢失，所以显式指定
const PB_ENV = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

function pb(cmd: "pbcopy" | "pbpaste", input?: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(cmd, [], { maxBuffer: 16 * 1024 * 1024, env: PB_ENV }, (err, stdout) => resolve(err ? "" : stdout));
    if (cmd === "pbcopy") child.stdin?.end(input ?? "");
  });
}

export function clipboardAvailable(): boolean {
  return process.platform === "darwin";
}

function osascript(script: string): Promise<string> {
  return new Promise((resolve) => execFile("osascript", ["-e", script], { timeout: 8000 }, (err, stdout) => resolve(err ? "" : stdout.trim())));
}

/** 当前正在运行的、有窗口的应用名（供用户选择目标应用） */
export async function listRunningApps(): Promise<string[]> {
  if (!clipboardAvailable()) return [];
  const out = await osascript('tell application "System Events" to get name of every process whose background only is false');
  const names = out.split(", ").map((n) => n.trim()).filter(Boolean);
  const skip = new Set(["Finder", "Terminal", "iTerm2", "node", "System Events", "Dock", "Electron"]);
  return [...new Set(names.filter((n) => !skip.has(n)))].sort((a, b) => a.localeCompare(b));
}

/** 一键发送：把文本放进剪贴板，并把目标应用切到前台；粘贴与回车由用户自己完成 */
export async function sendToApp(text: string, app?: string): Promise<{ ok: boolean; message: string }> {
  await pb("pbcopy", text);
  if (!app) return { ok: true, message: "copied" };
  const safe = app.replace(/"/g, "");
  const r = await osascript(`tell application "${safe}" to activate`);
  return { ok: true, message: r === "" ? "activated" : r };
}

export class RelayBackend implements Backend {
  mode: RelayMode;
  app?: string;
  ctx: RelayContext;
  turnCount = 0;
  ownTexts = new Set<string>();   // 我们自己放进剪贴板的内容，不能被当成回复

  constructor(mode: RelayMode, ctx: RelayContext, app?: string) {
    this.mode = mode;
    this.ctx = ctx;
    this.app = app;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const latest = req.turns[req.turns.length - 1].text;
    const first = this.turnCount === 0;
    this.turnCount++;
    // 桌面应用自己会保留对话上下文，所以只有第一条消息需要附带协作规则
    const text = first ? `${req.system}\n\n---\n\n${latest}` : latest;
    const requestId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (this.mode === "clipboard") {
      await pb("pbcopy", text);
      this.ownTexts.add(text);
    }
    this.ctx.emit({ type: "relay_wait", requestId, mode: this.mode, first, text, app: this.app });

    const reply = await new Promise<string>((resolve, reject) => {
      let done = false;
      const finish = (t: string) => { if (done) return; done = true; cleanup(); resolve(t.trim()); };
      const onAbort = () => { if (done) return; done = true; cleanup(); reject(new Error("aborted")); };
      let timer: NodeJS.Timeout | null = null;
      const cleanup = () => { pending.delete(requestId); req.signal.removeEventListener("abort", onAbort); if (timer) clearInterval(timer); };

      pending.set(requestId, { resolve: finish, own: this.ownTexts });
      req.signal.addEventListener("abort", onAbort, { once: true });

      if (this.mode === "clipboard") {
        let last = "", stableSince = 0;
        const announced = new Set<string>();
        timer = setInterval(async () => {
          if (done) return;
          const cur = await pb("pbpaste");
          const trimmed = cur.trim();
          if (!trimmed || this.ownTexts.has(cur) || this.ownTexts.has(trimmed) || announced.has(cur)) { last = ""; return; }
          if (cur !== last) { last = cur; stableSince = Date.now(); return; }
          if (Date.now() - stableSince >= 800) {
            announced.add(cur);
            // 交给页面：显示预览并倒计时，用户可取消；倒计时结束页面调用 /api/relay/reply
            this.ctx.emit({ type: "relay_candidate", requestId, text: cur });
          }
        }, 600);
      }
    });

    this.ctx.emit({ type: "relay_done", requestId });
    req.onDelta(reply);
    return { text: reply };
  }
}

/** 在 Terminal.app 新窗口里运行一条命令并把终端切到前台（用于一次性登录） */
export async function runInTerminal(command: string): Promise<{ ok: boolean; message: string }> {
  if (!clipboardAvailable()) return { ok: false, message: "only supported on macOS" };
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const r = await osascript(`tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`);
  return { ok: true, message: r };
}
