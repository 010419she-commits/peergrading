import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { assertActive, runRepositoryProcess } from "./process.ts";

export interface RepositoryCheck { argv: string[]; timeoutMs?: number }
export interface RepositoryConfig { path: string; sessionDir: string; checks?: RepositoryCheck[] }
export interface RepositoryInspection { path: string; head: string; branch: string; dirty: boolean; commonDir: string }
export interface RepositoryCheckResult {
  n: number; argv: string[]; code: number | null; ok: boolean; timedOut: boolean; stdout: string; stderr: string; durationMs: number;
}
export interface RepositorySnapshot {
  n: number; agent: "A" | "B"; summary: string; commit: string; baseCommit: string; patchFile: string; stat: string; checks: RepositoryCheckResult[];
}
export interface RepositoryManifest {
  sourcePath: string; worktreePath: string; branch: string; baseCommit: string; finalCommit: string;
  status: "running" | "approved" | "max_rounds" | "cancelled" | "failed";
  createdAt: string; error?: string; snapshots: RepositorySnapshot[]; checks: RepositoryCheckResult[];
}

/** Resolve even a not-yet-created destination through existing symlinks (/var on macOS). */
async function canonicalDestination(input: string): Promise<string> {
  let current = path.resolve(input); const suffix: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...suffix.reverse()); }
    catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current)); current = parent;
    }
  }
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await runRepositoryProcess(["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], cwd, { signal, maxOutput: 20_000_000, timeoutMs: 120_000 });
  if (result.code !== 0 || result.timedOut) throw new Error(`Git 操作失败 (${args[0]})：${(result.stderr || result.stdout).slice(-1000)}`);
  return result.stdout;
}

export async function inspectRepository(input: string, signal?: AbortSignal): Promise<RepositoryInspection> {
  assertActive(signal);
  if (typeof input !== "string" || !input.trim() || !path.isAbsolute(input)) throw new Error("请选择本机现有 Git 仓库的绝对路径");
  const selected = await fs.realpath(input);
  if ((await git(selected, ["rev-parse", "--is-inside-work-tree"], signal)).trim() !== "true") throw new Error("该目录不是 Git 工作仓库");
  const root = await fs.realpath((await git(selected, ["rev-parse", "--show-toplevel"], signal)).trim());
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).trim();
  const commonDir = await fs.realpath((await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal)).trim());
  const dirty = !!(await git(root, ["status", "--porcelain=v1", "--untracked-files=normal"], signal)).trim();
  return { path: root, head, branch, commonDir, dirty };
}

/** Full binary patch for the chosen commits; no external diff/textconv commands. */
export async function readRepositoryDiff(worktreePath: string, baseCommit: string, commit = "HEAD", signal?: AbortSignal): Promise<string> {
  if (!/^[a-f0-9]{40,64}$/i.test(baseCommit) || !(commit === "HEAD" || /^[a-f0-9]{40,64}$/i.test(commit))) throw new Error("无效的 Git 快照版本");
  return git(worktreePath, ["diff", "--no-ext-diff", "--no-textconv", "--binary", baseCommit, commit, "--"], signal);
}

function validateChecks(checks: RepositoryCheck[] = []): RepositoryCheck[] {
  if (!Array.isArray(checks) || checks.length > 12) throw new Error("最多配置 12 条校验命令");
  return checks.map((c) => {
    if (!c || !Array.isArray(c.argv) || !c.argv.length || c.argv.length > 100 || c.argv.some((a) => typeof a !== "string" || a.includes("\0") || a.length > 32_000) || !c.argv[0].trim()) throw new Error("校验命令必须是非空的 argv 字符串数组");
    const timeoutMs = c.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000) throw new Error("每条校验命令超时须在 100 毫秒至 15 分钟之间");
    return { argv: [...c.argv], timeoutMs };
  });
}

async function acquireLock(commonDir: string): Promise<() => Promise<void>> {
  const file = path.join(commonDir, "peergrading-repository.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      return async () => { try { if (JSON.parse(await fs.readFile(file, "utf8")).token === token) await fs.unlink(file); } catch {} };
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      let owner: { pid?: number };
      try { owner = JSON.parse(await fs.readFile(file, "utf8")); } catch { throw new Error("该仓库已有协作锁；请确认没有其他任务运行后清理 Git 目录中的 peergrading-repository.lock"); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) throw new Error("仓库协作锁无效，需人工确认是否仍有任务运行");
      try { process.kill(owner.pid!, 0); } catch (err: any) { if (err.code === "ESRCH") { await fs.unlink(file).catch(() => {}); continue; } }
      throw new Error("该仓库已有双 Agent 任务运行，请等待其完成或停止后重试");
    }
  }
  throw new Error("无法获得仓库协作锁，请重试");
}

export class RepositoryWorkspace {
  manifest: RepositoryManifest;
  artifactDir: string;
  checks: RepositoryCheck[];
  private release: () => Promise<void>;
  constructor(manifest: RepositoryManifest, artifactDir: string, checks: RepositoryCheck[], release: () => Promise<void>) {
    this.manifest = manifest; this.artifactDir = artifactDir; this.checks = checks; this.release = release;
  }
  async save() {
    const file = path.join(this.artifactDir, "manifest.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.manifest, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  async verifyHead(signal?: AbortSignal) {
    const root = await fs.realpath((await git(this.manifest.worktreePath, ["rev-parse", "--show-toplevel"], signal)).trim());
    if (root !== await fs.realpath(this.manifest.worktreePath)) throw new Error("任务工作目录的 Git 根路径意外改变，已停止操作");
    const head = (await git(this.manifest.worktreePath, ["rev-parse", "HEAD"], signal)).trim();
    const branch = (await git(this.manifest.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).trim();
    if (head !== this.manifest.finalCommit || branch !== this.manifest.branch) throw new Error("Agent 意外修改了 Git 分支或提交；已停止并保留现场，请检查任务工作目录");
  }
  async assertReadOnly(signal?: AbortSignal) {
    await this.verifyHead(signal);
    if ((await git(this.manifest.worktreePath, ["status", "--porcelain=v1", "--untracked-files=normal"], signal)).trim()) throw new Error("审查或讨论阶段意外修改了仓库；已停止并保留现场");
  }
  async runChecks(n: number, signal: AbortSignal, onCheck?: (check: RepositoryCheckResult) => void): Promise<RepositoryCheckResult[]> {
    const results: RepositoryCheckResult[] = [];
    for (const c of this.checks) {
      assertActive(signal);
      const start = Date.now();
      let r;
      try { r = await runRepositoryProcess(c.argv, this.manifest.worktreePath, { signal, timeoutMs: c.timeoutMs, maxOutput: 200_000 }); }
      catch (err: any) { if (signal.aborted) throw err; r = { code: null, timedOut: false, stdout: "", stderr: String(err?.message ?? err) }; }
      const result: RepositoryCheckResult = { n, argv: c.argv, ...r, ok: r.code === 0 && !r.timedOut, durationMs: Date.now() - start };
      results.push(result); this.manifest.checks.push(result); await this.save(); onCheck?.(result);
    }
    return results;
  }
  async snapshot(n: number, agent: "A" | "B", summary: string, checks: RepositoryCheckResult[], signal: AbortSignal): Promise<RepositorySnapshot> {
    assertActive(signal); await this.verifyHead(signal);
    const cwd = this.manifest.worktreePath;
    await git(cwd, ["add", "--all", "--", "."], signal);
    // An empty checkpoint still represents an author's turn and has a stable revision to review.
    await git(cwd, ["-c", "user.name=PeerGrading", "-c", "user.email=agent@peergrading.local", "commit", "--allow-empty", "--no-gpg-sign", "-m", `PeerGrading version ${n} — Agent ${agent}`], signal);
    const commit = (await git(cwd, ["rev-parse", "HEAD"], signal)).trim();
    const baseCommit = this.manifest.finalCommit;
    this.manifest.finalCommit = commit;
    const patchFile = `v${n}.patch`;
    await fs.writeFile(path.join(this.artifactDir, patchFile), await readRepositoryDiff(cwd, baseCommit, commit, signal), { mode: 0o600 });
    const stat = (await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--stat", baseCommit, commit, "--"], signal)).trim();
    const snapshot: RepositorySnapshot = { n, agent, summary, commit, baseCommit, patchFile, stat, checks };
    this.manifest.snapshots.push(snapshot); await this.save(); return snapshot;
  }
  async close(status: RepositoryManifest["status"], error?: string) {
    this.manifest.status = status;
    if (error) this.manifest.error = error;
    try { await this.save(); } finally { await this.release(); }
  }
}

export async function prepareRepository(config: RepositoryConfig, signal: AbortSignal): Promise<RepositoryWorkspace> {
  assertActive(signal);
  const checks = validateChecks(config.checks);
  const inspected = await inspectRepository(config.path, signal);
  if (inspected.dirty) throw new Error("原仓库存在未提交或未跟踪的改动。请先自行提交或保存，再开始协作；程序不会重置或覆盖这些文件");
  if (!path.isAbsolute(config.sessionDir)) throw new Error("仓库任务存储目录必须为绝对路径");
  const artifactDir = await canonicalDestination(path.resolve(config.sessionDir, "repository"));
  // A worktree inside the source would itself dirty the user's checkout.
  const compare = (p: string) => process.platform === "win32" ? p.toLowerCase() : p;
  if (compare(artifactDir) === compare(inspected.path) || compare(artifactDir).startsWith(compare(inspected.path) + path.sep)) throw new Error("任务存储目录必须位于所选仓库之外");
  const release = await acquireLock(inspected.commonDir);
  let workspace: RepositoryWorkspace | undefined;
  try {
    assertActive(signal);
    // Recheck after locking; another app might have changed files while inspection ran.
    const fresh = await inspectRepository(inspected.path, signal);
    if (fresh.dirty || fresh.head !== inspected.head) throw new Error("仓库在准备期间发生变化，请保存后重试");
    await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(artifactDir, "worktree");
    if (await fs.stat(path.join(artifactDir, "manifest.json")).then(() => true, () => false)
      || await fs.stat(worktreePath).then(() => true, () => false)) throw new Error("该任务目录已保存仓库协作现场，请创建新任务，避免覆盖现有成果");
    const branch = `codex/peergrading-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const manifest: RepositoryManifest = {
      sourcePath: inspected.path, worktreePath, branch, baseCommit: inspected.head, finalCommit: inspected.head,
      status: "running", createdAt: new Date().toISOString(), snapshots: [], checks: [],
    };
    workspace = new RepositoryWorkspace(manifest, artifactDir, checks, release);
    await workspace.save();
    await git(inspected.path, ["worktree", "add", "-b", branch, "--", worktreePath, inspected.head], signal);
    assertActive(signal); await workspace.assertReadOnly(signal); return workspace;
  } catch (e: any) {
    if (workspace) await workspace.close(signal.aborted ? "cancelled" : "failed", String(e?.message ?? e));
    else await release();
    throw e;
  }
}
