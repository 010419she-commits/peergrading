// finalizer/executor.ts — Docker（每条命令独立容器）或宿主 POSIX 执行
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { FinalizerError, LIMITS } from "./types.ts";
import type { Config, Command, CommandResult, Cleanup, Environment, SourceFile } from "./types.ts";

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* 已结束 */ } }
}

interface ProcessInput { executable: string; argv: string[]; cwd?: string; env?: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; onPid?: (pid: number) => void; }

async function processRun(input: ProcessInput): Promise<CommandResult> {
  if (input.signal.aborted) throw input.signal.reason;
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "", stderr = "", stdoutTruncated = false, stderrTruncated = false, timedOut = false, aborted = false, done = false;
    let exitCode: number | null = null;
    let startupError: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined, fallback: ReturnType<typeof setTimeout> | undefined, timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(input.executable, input.argv, { cwd: input.cwd, env: input.env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) input.onPid?.(child.pid);

    const force = () => { if (!child.pid) return; if (process.platform !== "win32") killGroup(child.pid, "SIGKILL"); else child.kill("SIGKILL"); };
    const finish = () => {
      if (done) return;
      done = true;
      force();
      if (timer) clearTimeout(timer); if (escalation) clearTimeout(escalation); if (fallback) clearTimeout(fallback);
      input.signal.removeEventListener("abort", onAbort);
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve({ commandId: "", stage: "probe", argv: [input.executable, ...input.argv], exitCode, timedOut, aborted, startupError, durationMs: Date.now() - started, stdout, stderr, stdoutTruncated, stderrTruncated });
    };
    const stop = () => {
      if (done) return;
      if (child.pid && process.platform !== "win32") killGroup(child.pid, "SIGTERM"); else child.kill("SIGTERM");
      if (!escalation) escalation = setTimeout(force, 500);
      if (!fallback) fallback = setTimeout(finish, 1500);
    };
    const onAbort = () => { aborted = true; stop(); };
    input.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs);

    child.stdout?.on("data", (data: Buffer) => { const text = data.toString("utf8"); const remaining = LIMITS.outputChars - stdout.length; stdout += text.slice(0, Math.max(0, remaining)); if (text.length > remaining) stdoutTruncated = true; });
    child.stderr?.on("data", (data: Buffer) => { const text = data.toString("utf8"); const remaining = LIMITS.outputChars - stderr.length; stderr += text.slice(0, Math.max(0, remaining)); if (text.length > remaining) stderrTruncated = true; });
    child.on("error", (error) => { startupError = String(error); finish(); });
    child.on("exit", (code) => { exitCode = code; force(); if (!fallback) fallback = setTimeout(finish, 500); });
    child.on("close", (code) => { exitCode = code; finish(); });
    if (input.signal.aborted) onAbort();
  });
}

export function chooseImage(files: SourceFile[], explicit?: string): string {
  if (explicit) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(explicit)) throw new FinalizerError("environment", "镜像名称格式无效");
    return explicit;
  }
  const node = files.some((f) => /\.(?:[cm]?js|jsx|tsx?|json)$/.test(f.path) && (f.path.endsWith("package.json") || /\.(?:[cm]?js|jsx|tsx?)$/.test(f.path)));
  const python = files.some((f) => f.path.endsWith(".py") || /(?:^|\/)(?:requirements\.txt|pyproject\.toml)$/.test(f.path));
  if (node && !python) return "node:22-bookworm-slim";
  if (python && !node) return "python:3.12-slim";
  throw new FinalizerError("environment", "多语言或无法识别环境，请显式指定执行镜像");
}

/** 供网页判断默认沙箱：docker 是否可用 */
export async function dockerAvailable(): Promise<boolean> {
  const r = await processRun({ executable: "docker", argv: ["info"], signal: new AbortController().signal, timeoutMs: 5000 });
  return r.exitCode === 0 && !r.startupError && !r.timedOut;
}

export class Executor {
  private config: Config;
  private runId: string;
  private imageId?: string;
  private containers = new Set<string>();
  private hostPids = new Set<number>();
  private sequence = 0;

  constructor(config: Config, runId: string) { this.config = config; this.runId = runId; }

  private async docker(argv: string[], signal: AbortSignal, timeoutMs: number): Promise<CommandResult> {
    return processRun({ executable: "docker", argv, signal, timeoutMs });
  }

  async prepare(files: SourceFile[], signal: AbortSignal, timeoutMs: number): Promise<{ image?: string; imageId?: string }> {
    if (this.config.sandbox === "host") {
      if (process.platform === "win32") throw new FinalizerError("environment", "本参考实现的宿主模式仅支持 POSIX；Windows 请用 Docker");
      return {};
    }
    const image = chooseImage(files, this.config.image);
    const info = await this.docker(["info"], signal, timeoutMs);
    if (signal.aborted) throw signal.reason;
    if (info.exitCode !== 0 || info.startupError || info.timedOut) throw new FinalizerError("environment", "Docker 不可用：" + (info.stderr || info.startupError || ""));
    let inspected = await this.docker(["image", "inspect", "--format", "{{.Id}}", image], signal, timeoutMs);
    if (signal.aborted) throw signal.reason;
    if (inspected.exitCode !== 0 && this.config.pull) {
      const pulled = await this.docker(["pull", image], signal, timeoutMs);
      if (signal.aborted) throw signal.reason;
      if (pulled.exitCode !== 0 || pulled.timedOut || pulled.startupError) throw new FinalizerError("environment", "镜像拉取失败：" + pulled.stderr);
      inspected = await this.docker(["image", "inspect", "--format", "{{.Id}}", image], signal, timeoutMs);
    }
    const id = inspected.stdout.trim();
    if (inspected.exitCode !== 0 || inspected.timedOut || !/^sha256:[a-f0-9]{64}$/.test(id))
      throw new FinalizerError("environment", "本地镜像不存在或无法读取；可先安装镜像或勾选“允许拉取镜像”");
    this.imageId = id;
    return { image, imageId: id };
  }

  private async workEnv(directory: string): Promise<Record<string, string>> {
    const infrastructure = path.join(directory, ".finalizer");
    for (const name of ["home", "tmp", "npm", "pip", "cargo", "go", "gocache"]) await fs.mkdir(path.join(infrastructure, name), { recursive: true });
    const work = this.config.sandbox === "docker" ? "/work" : directory;
    const p = (name: string) => `${work}/.finalizer/${name}`;
    return {
      HOME: p("home"), TMPDIR: this.config.sandbox === "docker" ? "/tmp" : p("tmp"), CI: "1", FORCE_COLOR: "0", PYTHONUNBUFFERED: "1",
      NPM_CONFIG_CACHE: p("npm"), PIP_CACHE_DIR: p("pip"), CARGO_HOME: p("cargo"), GOPATH: p("go"), GOMODCACHE: `${p("go")}/pkg/mod`, GOCACHE: p("gocache"),
    };
  }

  async execute(input: { directory: string; command: Command; stage: "probe" | "setup" | "run"; signal: AbortSignal; timeoutMs: number }): Promise<CommandResult> {
    const env = await this.workEnv(input.directory);
    if (input.signal.aborted) throw input.signal.reason;
    let result: CommandResult;
    if (this.config.sandbox === "docker") {
      if (!this.imageId) throw new FinalizerError("environment", "执行镜像尚未准备");
      const name = `finalizer-${this.runId}-${++this.sequence}`;
      this.containers.add(name);
      const argv = [
        "run", "--rm", "--pull", "never", "--name", name, "--label", `finalizer.runId=${this.runId}`,
        "--network", input.stage === "setup" && this.config.allowInstallNetwork ? "bridge" : "none",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "512m", "--cpus", "1",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--mount", `type=bind,source=${input.directory},target=/work`, "--workdir", "/work",
      ];
      if (process.platform !== "win32" && process.getuid && process.getgid) argv.push("--user", `${process.getuid()}:${process.getgid()}`);
      for (const [key, value] of Object.entries(env)) argv.push("--env", `${key}=${value}`);
      argv.push(this.imageId, ...input.command.argv);
      result = await this.docker(argv, input.signal, input.timeoutMs);
      if (result.exitCode === 0 && !result.timedOut && !result.aborted && !result.startupError) this.containers.delete(name);
    } else {
      let pid: number | undefined;
      try {
        result = await processRun({
          executable: input.command.argv[0], argv: input.command.argv.slice(1), cwd: input.directory,
          env: { ...env, PATH: process.env.PATH, LANG: process.env.LANG || "C.UTF-8" },
          signal: input.signal, timeoutMs: input.timeoutMs, onPid: (value) => { pid = value; this.hostPids.add(value); },
        });
      } finally { if (pid) this.hostPids.delete(pid); }
    }
    return { ...result, commandId: input.command.id, stage: input.stage, argv: input.command.argv };
  }

  async environment(input: { directory: string; prepared: { image?: string; imageId?: string }; signal: AbortSignal; remaining: () => number }): Promise<Environment> {
    const probes: CommandResult[] = [];
    for (const program of ["node", "npm", "python3", "python", "cargo", "go", "java"]) {
      if (input.signal.aborted) throw input.signal.reason;
      const timeoutMs = Math.min(5000, input.remaining());
      if (timeoutMs <= 0) throw new FinalizerError("budget", "预算耗尽");
      probes.push(await this.execute({ directory: input.directory, command: { id: `probe-${program}`, argv: [program, program === "java" ? "-version" : "--version"] }, stage: "probe", signal: input.signal, timeoutMs }));
    }
    const docker = this.config.sandbox === "docker";
    const python = docker ? "/work/.venv/bin/python" : ".venv/bin/python";
    return {
      sandbox: this.config.sandbox, ...input.prepared,
      workDirectory: docker ? "/work" : input.directory,
      setupNetwork: docker ? (this.config.allowInstallNetwork ? "bridge" : "none") : "宿主网络，不可强制限制",
      runNetwork: docker ? "none" : "宿主网络，不可强制限制",
      conventions: [
        "每条命令独立启动，工作目录和磁盘内容保留，shell 激活状态不保留。",
        `Python：先 python3 -m venv .venv，再 ${python} -m pip / -m pytest。`,
        "Node：依赖装入工作目录；优先使用本地 node_modules/.bin 工具。",
        "HOME、npm/pip 缓存、CARGO_HOME、GOPATH/GOCACHE 位于 .finalizer/。",
        "容器根目录只读；依赖与构建输出必须写入工作目录或 /tmp。",
        "环境探测的失败仅表示该探测命令不可用，不是成果执行失败。",
      ],
      probes,
    };
  }

  async cleanup(signal: AbortSignal): Promise<Cleanup> {
    if (this.config.sandbox === "host") {
      for (const pid of this.hostPids) killGroup(pid, "SIGKILL");
      return { ok: true, detail: "已清理本执行器记录的进程组；无法核实脱离进程组的进程", residuals: [] };
    }
    const problems: string[] = [];
    for (const name of this.containers) {
      if (signal.aborted) throw signal.reason;
      const r = await this.docker(["rm", "-f", name], signal, 5000);
      if (r.exitCode !== 0 && !r.stderr.includes("No such container")) problems.push(name);
    }
    const listed = await this.docker(["ps", "-a", "--filter", `label=finalizer.runId=${this.runId}`, "--format", "{{.ID}}"], signal, 5000);
    if (listed.exitCode !== 0 || listed.timedOut || listed.startupError) return { ok: false, detail: "无法核实容器清理结果：" + listed.stderr, residuals: problems };
    const residuals = listed.stdout.trim().split(/\s+/).filter(Boolean);
    return { ok: residuals.length === 0, detail: residuals.length ? "仍存在本任务容器，请按报告中的 ID 检查" : "检查时未发现本任务容器残留", residuals };
  }
}
