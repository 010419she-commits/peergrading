import { spawn, type ChildProcess } from "node:child_process";
import { envForLauncher, launcherFor, findBin, killTree, WIN } from "../agents/launch.ts";

export const abortError = () => new Error("aborted");
export function assertActive(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }

/** Git and check processes must not inherit a caller's alternate index/work tree. */
export function repositoryEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !/^GIT_/i.test(key)));
}

/** No shell fallback: npm shims are resolved to their Node entry point on Windows. */
export function spawnRepositoryProcess(bin: string, args: string[], cwd: string, env = repositoryEnv()): ChildProcess {
  // Windows spawn cannot execute "npm" through PATHEXT alone. Resolve its .cmd
  // shim first, then use the existing launcher to run Node directly, without cmd.exe.
  const resolved = WIN && !/[\\/]/.test(bin) ? findBin(bin.replace(/\.(?:exe|cmd|bat|com)$/i, "")) ?? bin : bin;
  const launcher = launcherFor(resolved);
  if (launcher.shell) throw new Error(`无法安全启动 ${bin}：请安装可直接执行的程序或标准 npm 命令包装器`);
  const child = spawn(launcher.file, [...launcher.prefix, ...args], {
    cwd, env: envForLauncher(launcher, env), shell: false,
    detached: !WIN, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdin?.on("error", () => {});
  return child;
}

/** The group includes shell/tool descendants started by a CLI or validation script. */
export function stopRepositoryProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  if (WIN) { killTree(child, signal); return; }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export function runRepositoryProcess(argv: string[], cwd: string, opts: { signal?: AbortSignal; timeoutMs?: number; maxOutput?: number } = {}): Promise<ProcessResult> {
  assertActive(opts.signal);
  if (!argv.length || argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("校验命令必须是非空的 argv 字符串数组");
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawnRepositoryProcess(argv[0], argv.slice(1), cwd); } catch (e) { reject(e); return; }
    let stdout = "", stderr = "", timedOut = false, outputExceeded = false, escalation: ReturnType<typeof setTimeout> | undefined;
    const max = opts.maxOutput ?? 2_000_000;
    const terminate = () => {
      stopRepositoryProcess(child);
      escalation ??= setTimeout(() => stopRepositoryProcess(child, "SIGKILL"), 1000);
      escalation.unref();
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, opts.timeoutMs ?? 30_000);
    opts.signal?.addEventListener("abort", terminate, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      // Kill descendants even when their parent already exited on SIGTERM.
      if (escalation) { stopRepositoryProcess(child, "SIGKILL"); clearTimeout(escalation); }
      opts.signal?.removeEventListener("abort", terminate);
    };
    child.stdout!.on("data", (d) => { stdout += d; if (stdout.length > max) { stdout = stdout.slice(0, max); outputExceeded = true; terminate(); } });
    child.stderr!.on("data", (d) => { stderr = (stderr + d).slice(-max); });
    child.once("error", (e) => { cleanup(); reject(e); });
    child.once("close", (code) => {
      cleanup(); if (!WIN) stopRepositoryProcess(child, "SIGKILL");
      if (opts.signal?.aborted) reject(abortError());
      else if (outputExceeded) reject(new Error("命令输出超过安全大小限制，任务已停止"));
      else resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin!.end();
    if (opts.signal?.aborted) terminate();
  });
}
