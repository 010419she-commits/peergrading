// finalizer/validate.ts — 结构校验、路径检查、文件快照与机器验证
import { promises as fs, constants } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { FinalizerError, LIMITS } from "./types.ts";
import type { SourceFile, Plan, Command, Check, CheckResult, Change, CommandResult } from "./types.ts";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FinalizerError("invalid_plan", "需要 JSON 对象");
  return value as Record<string, unknown>;
}

export function parseJSON(text: string): unknown {
  if (text.length > LIMITS.modelChars) throw new FinalizerError("invalid_plan", "模型回复超过大小上限");
  try { return JSON.parse(text); } catch { throw new FinalizerError("invalid_plan", "模型未返回严格 JSON"); }
}

export function safeRel(value: unknown): string {
  if (
    typeof value !== "string" || !value || !/^[A-Za-z0-9_.@/-]+$/.test(value) || value.startsWith("/") || value.endsWith("/") ||
    value.split("/").some((s) => !s || s === "." || s === ".." || s.toLowerCase() === ".git" || s.toLowerCase() === ".finalizer")
  ) throw new FinalizerError("invalid_plan", `非法相对路径：${String(value)}`);
  return value;
}

export function validateFiles(value: unknown): SourceFile[] {
  if (!Array.isArray(value) || value.length > LIMITS.files) throw new FinalizerError("invalid_plan", "无效的文件数组");
  let size = 0;
  const seen = new Set<string>();
  const files = value.map((item) => {
    const row = object(item);
    const p = safeRel(row.path);
    if (seen.has(p.toLowerCase())) throw new FinalizerError("invalid_plan", `文件路径重复：${p}`);
    seen.add(p.toLowerCase());
    if (typeof row.content !== "string" || row.content.length > LIMITS.fileChars) throw new FinalizerError("invalid_plan", `文件内容无效或过大：${p}`);
    size += row.content.length;
    return { path: p, content: row.content };
  });
  if (size > LIMITS.totalFileChars) throw new FinalizerError("invalid_plan", "文件总大小超过上限");
  return files;
}

export async function inside(root: string, relative: string): Promise<string> {
  const rel = safeRel(relative);
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  const back = path.relative(base, target);
  if (!back || back.startsWith(`..${path.sep}`) || back === ".." || path.isAbsolute(back)) throw new FinalizerError("invalid_plan", "路径越界");
  const parts = rel.split("/");
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new FinalizerError("invalid_plan", `拒绝符号链接：${rel}`);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new FinalizerError("invalid_plan", `父路径不是目录：${rel}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}

export async function mkdirInside(root: string, relative: string): Promise<string> {
  const target = await inside(root, relative);
  await fs.mkdir(target, { recursive: true });
  await inside(root, relative);
  return target;
}

export async function writeInside(root: string, relative: string, content: string): Promise<void> {
  const target = await inside(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await inside(root, relative);
  const handle = await fs.open(target, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
}

export interface FileState { content: string | null; hash: string | null; error?: string; }

export async function readState(root: string, relative: string, limit = LIMITS.outputChars): Promise<FileState> {
  try {
    const target = await inside(root, relative);
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit * 4) throw new Error("不是普通文件，或超过读取上限");
      const buffer = Buffer.alloc(limit * 4 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > limit * 4) throw new Error("文件超过读取上限");
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      if (content.length > limit) throw new Error("文本超过读取上限");
      return { content, hash: sha(content) };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: null, hash: null };
    return { content: null, hash: null, error: String(error) };
  }
}

export async function changes(root: string, expected: SourceFile[]): Promise<Change[]> {
  const out: Change[] = [];
  for (const file of expected) {
    const actual = await readState(root, file.path, LIMITS.fileChars);
    if (actual.content !== file.content || actual.error) out.push({ path: file.path, before: file.content, after: actual.content, error: actual.error });
  }
  return out;
}

export function approvedDiff(original: SourceFile[], current: SourceFile[]): Change[] {
  const before = new Map(original.map((f) => [f.path, f.content]));
  return current.filter((f) => before.get(f.path) !== f.content).map((f) => ({ path: f.path, before: before.get(f.path) ?? null, after: f.content }));
}

function commands(value: unknown): Command[] {
  if (!Array.isArray(value) || value.length > LIMITS.commands) throw new FinalizerError("invalid_plan", "命令数量无效");
  return value.map((item) => {
    const row = object(item);
    if (
      typeof row.id !== "string" || !/^[\w-]{1,64}$/.test(row.id) || !Array.isArray(row.argv) || !row.argv.length || row.argv.length > 128 ||
      row.argv.some((v) => typeof v !== "string" || v.includes("\0") || v.length > 16_384) || !(row.argv[0] as string).trim()
    ) throw new FinalizerError("invalid_plan", "命令须有唯一 ID 和非空 argv");
    const executable = path.posix.basename((row.argv[0] as string).replace(/\\/g, "/")).toLowerCase();
    if (["pip", "pip3", "pytest"].includes(executable)) throw new FinalizerError("invalid_plan", "请使用虚拟环境解释器 -m pip / -m pytest");
    return { id: row.id as string, argv: row.argv as string[] };
  });
}

export function validatePlan(value: unknown, original: SourceFile[], tracked: SourceFile[], repair: boolean): Plan {
  const row = object(value);
  const files = validateFiles(row.files);
  const setup = commands(row.setup);
  const run = commands(row.run);
  if (!run.length || setup.length + run.length > LIMITS.commands) throw new FinalizerError("invalid_plan", "必须有运行命令，且总命令数不超限");
  const allIds = [...setup, ...run].map((c) => c.id);
  if (new Set(allIds).size !== allIds.length) throw new FinalizerError("invalid_plan", "命令 ID 重复");

  const known = new Map(tracked.map((f) => [f.path.toLowerCase(), f.path]));
  for (const file of files) {
    const existing = known.get(file.path.toLowerCase());
    if (existing && (!repair || existing !== file.path)) throw new FinalizerError("invalid_plan", `不允许覆盖文件：${file.path}`);
    if (!existing && original.some((f) => path.posix.basename(f.path).toLowerCase() === path.posix.basename(file.path).toLowerCase()))
      throw new FinalizerError("invalid_plan", `新增文件可能遮蔽源码模块：${file.path}`);
  }

  const entrypoint = safeRel(row.entrypoint);
  if (!original.some((f) => f.path === entrypoint)) throw new FinalizerError("invalid_plan", "入口必须来自所选版本源码");
  if (typeof row.notes !== "string") throw new FinalizerError("invalid_plan", "notes 必须为字符串");
  if (!Array.isArray(row.checks) || !row.checks.length || row.checks.length > LIMITS.checks) throw new FinalizerError("invalid_plan", "必须提供有效的 checks");

  const runIds = new Set(run.map((c) => c.id));
  const trackedPaths = new Set([...tracked, ...files].map((f) => f.path));
  const checks: Check[] = row.checks.map((item) => {
    const c = object(item);
    if (typeof c.commandId !== "string" || !runIds.has(c.commandId)) throw new FinalizerError("invalid_plan", "check 必须引用运行阶段命令");
    const base = { commandId: c.commandId };
    if (c.kind === "stdout-includes" || c.kind === "stdout-not-includes") {
      if (typeof c.value !== "string" || !c.value.trim() || c.value.length > 4096) throw new FinalizerError("invalid_plan", "输出检查文本无效");
      return { ...base, kind: c.kind, value: c.value };
    }
    if (c.kind === "json-field-equals") {
      if (
        !Array.isArray(c.field) || !c.field.length || c.field.some((f) => typeof f !== "string" || !f || ["__proto__", "prototype", "constructor"].includes(f)) ||
        !(c.value === null || typeof c.value === "string" || typeof c.value === "boolean" || (typeof c.value === "number" && Number.isFinite(c.value)))
      ) throw new FinalizerError("invalid_plan", "JSON 字段检查无效");
      return { ...base, kind: "json-field-equals", field: c.field as string[], value: c.value as string | number | boolean | null };
    }
    if (c.kind === "file-includes" || c.kind === "file-exists") {
      const p = safeRel(c.path);
      if (trackedPaths.has(p)) throw new FinalizerError("invalid_plan", "产物检查不能读取源码或辅助文件");
      if (c.kind === "file-exists") return { ...base, kind: "file-exists", path: p };
      if (typeof c.value !== "string" || !c.value.trim() || c.value.length > 4096) throw new FinalizerError("invalid_plan", "文件内容检查无效");
      return { ...base, kind: "file-includes", path: p, value: c.value };
    }
    throw new FinalizerError("invalid_plan", `不支持的检查类型：check 必须有 kind 字段（不是 type），取值为 stdout-includes / stdout-not-includes / json-field-equals / file-includes / file-exists，收到 ${JSON.stringify(c.kind ?? c.type ?? null)}`);
  });

  if (!checks.some((c) => ["stdout-includes", "json-field-equals", "file-includes"].includes(c.kind)))
    throw new FinalizerError("invalid_plan", "必须至少有一条实质性检查，不能只检查无报错或文件存在");
  return { files, setup, run, checks, entrypoint, notes: row.notes };
}

export function checkResult(check: Check, result: CommandResult, before?: FileState, after?: FileState): CheckResult {
  let passed = false;
  let detail = "";
  if ("path" in check) {
    const fresh = !!after && !after.error && after.content !== null && !before?.error && after.hash !== before?.hash;
    passed = fresh && (check.kind === "file-exists" || after!.content!.includes(check.value));
    detail = fresh ? "本命令生成或改变产物，已检查内容" : "产物不存在、读取失败或内容未变化，不能作为本次运行证据";
  } else if (check.kind === "stdout-includes") {
    passed = result.stdout.includes(check.value); detail = "检查实际 stdout";
  } else if (check.kind === "stdout-not-includes") {
    passed = !result.stdout.includes(check.value); detail = "辅助条件：stdout 不包含指定文本";
  } else {
    try {
      let current: unknown = JSON.parse(result.stdout);
      for (const key of check.field) {
        if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) throw new Error("字段不存在");
        current = (current as Record<string, unknown>)[key];
      }
      passed = Object.is(current, check.value); detail = "检查 stdout JSON 字段";
    } catch (error) { detail = `JSON 检查失败：${String(error)}`; }
  }
  return { check, passed, detail };
}
