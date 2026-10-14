// finalizer/extract.ts — 从成果文本中识别代码围栏，并确定文件布局
import { FinalizerError, LIMITS } from "./types.ts";
import type { SourceFile } from "./types.ts";
import { safeRel, validateFiles } from "./validate.ts";

export interface Block { id: string; language: string; path?: string; content: string; context: string; }
export interface Extracted { blocks: Block[]; excluded: { reason: string; language: string }[]; }

export function extract(content: string): Extracted {
  if (content.length > LIMITS.modelChars) throw new FinalizerError("input", "成果文本超过大小上限");

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  const excluded: Extracted["excluded"] = [];

  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!opening) continue;

    const fence = opening[1];
    const info = opening[2].trim();
    const language = (info.split(/\s+/)[0] || "").toLowerCase();
    const context = lines.slice(Math.max(0, i - 3), i).join("\n");
    const body: string[] = [];
    let closed = false;

    for (i++; i < lines.length; i++) {
      const closing = lines[i].match(/^ {0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) { closed = true; break; }
      body.push(lines[i]);
    }
    if (!closed) throw new FinalizerError("unconfirmed", "发现未闭合代码围栏");

    const text = body.join("\n") + "\n";
    const metadata = info.match(/(?:^|\s)(?:title|file|path)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    const marker = body[0]?.match(/^\s*(?:\/\/|#|--|<!--|\/\*)\s*(?:file|path|filename):\s*([^\s*>]+)/);
    const heading = lines
      .slice(Math.max(0, i - body.length - 4), i - body.length - 1)
      .reverse()
      .find((s) => s.trim())
      ?.trim()
      .match(/^(?:#{1,6}\s*)?\**`?([\w./@-]+\.[\w]+)`?\**[:：]?$/);

    const rawPath = metadata?.[1] || metadata?.[2] || metadata?.[3] || marker?.[1] || heading?.[1];

    const role = info.match(/(?:^|\s)role=(example|output|old)(?:\s|$)/);
    if (role || (!rawPath && ["text", "console", "diff"].includes(language))) {
      excluded.push({ language, reason: role ? `明确标注 role=${role[1]}` : "说明、输出或差异块" });
      continue;
    }
    if (!text.trim()) continue;

    blocks.push({ id: `block-${blocks.length + 1}`, language, path: rawPath ? safeRel(rawPath) : undefined, content: text, context });
    if (blocks.length > LIMITS.files) throw new FinalizerError("input", "代码块数量超过上限");
  }
  return { blocks, excluded };
}

export function automaticLayout(blocks: Block[]): SourceFile[] | undefined {
  if (blocks.some((b) => !b.path)) return undefined;
  const paths = blocks.map((b) => b.path!.toLowerCase());
  if (new Set(paths).size !== paths.length) return undefined;
  return validateFiles(blocks.map((b) => ({ path: b.path!, content: b.content })));
}

/** 每个候选块必须映射一次，或以结构化理由排除；带路径的块不能改名；同一路径最多选一个候选 */
export function resolveLayout(value: unknown, blocks: Block[]): { files: SourceFile[]; decisions: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FinalizerError("invalid_plan", "布局不是 JSON 对象");
  const v = value as Record<string, unknown>;
  if (v.verdict === "unconfirmed") throw new FinalizerError("unconfirmed", typeof v.reason === "string" ? v.reason : "无法确定代码布局");
  if (!Array.isArray(v.mapping) || !Array.isArray(v.ignored)) throw new FinalizerError("invalid_plan", "布局须包含 mapping 和 ignored");

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const used = new Set<string>();
  const files: SourceFile[] = [];
  const take = (id: unknown): Block => {
    if (typeof id !== "string" || !byId.has(id) || used.has(id)) throw new FinalizerError("invalid_plan", "代码块 ID 不存在或重复");
    used.add(id);
    return byId.get(id)!;
  };
  for (const item of v.mapping) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new FinalizerError("invalid_plan", "无效的代码块映射");
    const row = item as Record<string, unknown>;
    const block = take(row.blockId);
    const p = safeRel(row.path);
    if (block.path && block.path !== p) throw new FinalizerError("invalid_plan", "带文件名的源码不能在布局中改名");
    files.push({ path: p, content: block.content });
  }
  for (const item of v.ignored) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new FinalizerError("invalid_plan", "无效的排除项");
    const row = item as Record<string, unknown>;
    take(row.blockId);
    if (typeof row.reason !== "string" || !row.reason.trim()) throw new FinalizerError("invalid_plan", "排除代码块必须提供理由");
  }
  if (used.size !== blocks.length) throw new FinalizerError("invalid_plan", "存在未处理的代码块");
  if (!files.length) throw new FinalizerError("unconfirmed", "存在代码候选，但未确定可运行源码");
  return { files: validateFiles(files), decisions: value };
}
