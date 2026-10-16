// orchestrator.ts — 双 Agent「作者 / 审查者」轮换协作循环（后端无关）
import type { AgentInfo, Backend, Lang, Turn } from "./agents/types.ts";
import { createBackend } from "./agents/backends.ts";
import { newMediaRun, processMedia, MEDIA_LIMITS, type MediaEvent, type MediaProvider, type MediaRecord, type MediaRun } from "./agents/media.ts";
import { prepareRepository, readRepositoryDiff, type RepositoryConfig, type RepositoryManifest, type RepositorySnapshot, type RepositoryCheckResult } from "./repository/workspace.ts";
import { assertActive } from "./repository/process.ts";

export type AgentKey = "A" | "B";

export interface AgentConfig {
  name: string;
  persona: string;
  agent: AgentInfo;     // 由自动检测得到的智能体
}

export interface RunConfig {
  task: string;
  lang: Lang;
  agentA: AgentConfig;
  agentB: AgentConfig;
  maxRounds: number;
  discussionTurns: number;
  cwd: string;          // CLI 类智能体的工作目录
  /** 协作中生成图片 / 视频：agent 用 ```image / ```video 围栏描述画面，由 provider 生成后存到 dir */
  media?: { provider: MediaProvider; dir: string; images: boolean; videos: boolean };
  repository?: RepositoryConfig;
}

export type Kind = "draft" | "review" | "reply" | "counter" | "revision";

export type Event =
  | { type: "status"; text: string }
  | { type: "message_start"; id: string; agent: AgentKey; name: string; model: string; source: string; kind: Kind; round: number }
  | { type: "delta"; id: string; text: string }
  | { type: "progress"; id: string; phase: "reasoning" | "running"; chars?: number }
  | { type: "message_end"; id: string; verdict?: "approve" | "revise"; model?: string; usage?: { input: number; output: number }; text?: string }   // text：媒体围栏被替换后的最终正文（仅在有替换时给出）
  | MediaEvent
  | { type: "version"; n: number; agent: AgentKey; name: string; content: string }
  | { type: "repository_ready"; repository: RepositoryManifest }
  | { type: "repository_snapshot"; snapshot: RepositorySnapshot }
  | { type: "repository_check"; check: RepositoryCheckResult }
  | { type: "relay_wait"; id: string; agent: AgentKey; name: string; requestId: string; mode: "manual" | "clipboard"; first: boolean; text: string }
  | { type: "relay_candidate"; id: string; requestId: string; text: string }
  | { type: "relay_done"; id: string; requestId: string }
  | { type: "done"; reason: string; finalVersion: number }
  | { type: "error"; message: string };

export type Emit = (ev: Event) => void;

const DELIVERABLE_RE = /<deliverable>([\s\S]*?)<\/deliverable>/i;
const APPROVE_MARKS = ["【结论】通过", "VERDICT: APPROVE"];
const REVISE_MARKS = ["【结论】需修改", "VERDICT: REVISE"];

function extractDeliverable(text: string): string {
  const m = text.match(DELIVERABLE_RE);
  return (m ? m[1] : text).trim();
}

function parseVerdict(text: string): "approve" | "revise" {
  const up = text.toUpperCase();
  const last = (marks: string[]) => Math.max(...marks.map((m) => up.lastIndexOf(m.toUpperCase())));
  const a = last(APPROVE_MARKS), r = last(REVISE_MARKS);
  if (a < 0 && r < 0) return "revise";
  return a > r ? "approve" : "revise";
}

// ---------- 提示词（中 / 英） ----------

const P = {
  zh: {
    system: (self: string, other: string, persona: string, task: string, media = "") => [
      `你是「${self}」，正在与另一位 AI 智能体「${other}」协作完成用户交付的任务。`,
      `两位智能体轮流担任「作者」与「审查者」：作者产出成果；审查者严格审查并与作者讨论；随后由审查者亲自修改出新版本，再交回对方审查。如此往复，直到成果足够完善。`,
      ``,
      `协作规则：`,
      `1. 每当你需要给出（或修改）成果时，必须把**完整的**成果放在 <deliverable></deliverable> 标签内，标签外只写简短说明。不要只给增量 diff，必须输出整份成果。`,
      `2. 每当你担任审查者时，按严重程度列出具体、可操作的问题（指出位置与改法），避免空泛表扬；若成果确已达到高质量标准，不要为了挑刺而挑刺。审查末尾单独一行写「【结论】通过」或「【结论】需修改」。`,
      `3. 讨论阶段要坦诚：同意就说明原因，不同意就给出理由和替代方案。目标是把任务做到最好，而不是赢得争论。`,
      `4. 不要调用任何工具、不要读写文件，只用文字作答。使用与任务相同的语言；若不明确，使用中文。`,
      `5. 成果中若含代码：每个交付文件只输出一份完整内容，代码围栏标注 title=<相对路径>（例如 \`\`\`python title=main.py）。示例、旧代码及运行输出明确标注 role=example、role=old、role=output。`,
      media,
      persona.trim() ? `\n你的额外人设/关注点：${persona.trim()}` : ``,
      ``, `用户的原始任务如下：`, `<task>\n${task}\n</task>`,
    ].join("\n"),
    draft: () => `请完成上面 <task> 中的任务。把完整成果放在 <deliverable></deliverable> 标签内，标签外简要说明你的思路与关键取舍。`,
    review: (author: string, n: number, content: string) =>
      `以下是「${author}」完成的第 ${n} 版成果：\n\n<deliverable>\n${content}\n</deliverable>\n\n请严格审查：对照原始任务检查正确性、完整性、质量与可读性，按严重程度列出具体问题和改进建议。最后单独一行写「【结论】通过」或「【结论】需修改」。`,
    reply: (reviewer: string, n: number, review: string) =>
      `「${reviewer}」对你的第 ${n} 版成果给出了如下审查意见：\n\n<review>\n${review}\n</review>\n\n请逐条回应：同意的说明原因并补充你认为更好的改法；不同意的说明理由并给出替代方案。本步骤只讨论，不要重写成果。`,
    counter: (author: string, reply: string) =>
      `「${author}」对你的审查意见回应如下：\n\n<reply>\n${reply}\n</reply>\n\n请针对分歧点继续讨论，明确哪些意见维持、哪些接受对方说法，并给出修改方向。本步骤只讨论，不要重写成果。最后单独一行写「【结论】通过」（如果你被说服当前版本已达标）或「【结论】需修改」。`,
    revision: (author: string, reply: string, n: number) =>
      `「${author}」对你意见的最新回应如下：\n\n<reply>\n${reply}\n</reply>\n\n现在由你亲自修改，输出第 ${n} 版**完整**成果，放在 <deliverable></deliverable> 标签内。采纳双方达成共识的改进；对未达成共识的点按你的最佳判断处理，并在标签外简要说明改了什么、为何这样取舍。`,
    s_draft: (a: string) => `「${a}」开始完成任务（第 1 版）…`,
    s_review: (r: number, who: string, n: number) => `第 ${r} 轮：「${who}」审查第 ${n} 版…`,
    s_approved: (r: number, who: string, n: number) => `第 ${r} 轮审查：「${who}」认为第 ${n} 版已达标，协作结束。`,
    s_reply: (r: number, t: number, T: number, who: string) => `第 ${r} 轮讨论 ${t}/${T}：「${who}」回应审查意见…`,
    s_counter: (r: number, t: number, T: number, who: string) => `第 ${r} 轮讨论 ${t}/${T}：「${who}」继续讨论…`,
    s_approved2: (r: number, who: string, n: number) => `第 ${r} 轮讨论后：「${who}」认可第 ${n} 版，协作结束。`,
    s_revise: (r: number, who: string, n: number) => `第 ${r} 轮：「${who}」根据讨论修改，产出第 ${n} 版…`,
    s_max: (m: number, n: number) => `已达到最大轮数（${m}），以第 ${n} 版作为最终成果。`,
    mediaRule: (images: boolean, videos: boolean) => {
      const kinds = [images ? "图片" : "", videos ? "视频" : ""].filter(Boolean).join("或");
      const lines = [`6. 成果需要${kinds}时，不要写"此处应有图"，而是用围栏请求生成，系统会自动生成并把围栏替换成 ![描述](media://…) 引用，另一位智能体与用户都能看到。`];
      if (images) lines.push(`   图片：\`\`\`image aspect=16:9（可选 1:1 / 16:9 / 9:16，可加 quality=low|medium|high），下一行起写完整、具体的画面描述（主体、场景、风格、光线、构图），再以 \`\`\` 结束。`);
      if (videos) lines.push(`   视频：\`\`\`video seconds=8 aspect=16:9（seconds 可为 4 / 8 / 12），下一行起写镜头与画面描述。`);
      lines.push(`   修改成果时原样保留已生成的 ![…](media://…) 引用，只有需要新的或不同的画面时才再写围栏。每条消息最多 ${MEDIA_LIMITS.perMessageImages} 张图、${MEDIA_LIMITS.perMessageVideos} 个视频；本次协作合计最多 ${MEDIA_LIMITS.perRunImages} 张图、${MEDIA_LIMITS.perRunVideos} 个视频。${!videos ? "视频生成未开启。" : ""}${!images ? "图片生成未开启。" : ""}`);
      return lines.join("\n");
    },
  },
  en: {
    system: (self: string, other: string, persona: string, task: string, media = "") => [
      `You are "${self}", collaborating with another AI agent, "${other}", on a task from the user.`,
      `The two agents alternate between the roles of author and reviewer: the author produces the deliverable; the reviewer critiques it and discusses with the author; then the reviewer personally revises it into a new version and hands it back for the other to review. This repeats until the work is excellent.`,
      ``,
      `Rules:`,
      `1. Whenever you produce or revise the deliverable, put the **complete** deliverable inside <deliverable></deliverable> tags, with only a brief note outside. Never output a partial diff.`,
      `2. When reviewing, list concrete, actionable issues ordered by severity (where and how to fix). No vague praise, but do not nitpick work that already meets a high bar. End the review with a line containing exactly "VERDICT: APPROVE" or "VERDICT: REVISE".`,
      `3. In discussion, be candid: explain why you agree, or give reasons and alternatives when you disagree. The goal is the best result, not winning the argument.`,
      `4. Do not call tools or touch files; answer in text only. Use the language of the task; if unclear, use English.`,
      `5. If the deliverable contains code: output each delivered file exactly once and in full, and tag its code fence with title=<relative path> (e.g. \`\`\`python title=main.py). Mark examples, old code and program output with role=example, role=old or role=output.`,
      media,
      persona.trim() ? `\nYour extra persona / focus: ${persona.trim()}` : ``,
      ``, `The user's original task:`, `<task>\n${task}\n</task>`,
    ].join("\n"),
    draft: () => `Complete the task in <task> above. Put the complete deliverable inside <deliverable></deliverable>, and briefly explain your approach and key trade-offs outside the tags.`,
    review: (author: string, n: number, content: string) =>
      `Here is version ${n} of the deliverable by "${author}":\n\n<deliverable>\n${content}\n</deliverable>\n\nReview it rigorously against the original task: correctness, completeness, quality, readability. List concrete issues and improvements by severity. End with a single line "VERDICT: APPROVE" or "VERDICT: REVISE".`,
    reply: (reviewer: string, n: number, review: string) =>
      `"${reviewer}" reviewed your version ${n} as follows:\n\n<review>\n${review}\n</review>\n\nRespond point by point: where you agree, say why and suggest an even better fix; where you disagree, give reasons and an alternative. Discussion only — do not rewrite the deliverable in this step.`,
    counter: (author: string, reply: string) =>
      `"${author}" responded to your review:\n\n<reply>\n${reply}\n</reply>\n\nContinue the discussion on the points of disagreement: state which of your points you keep, which you concede, and the direction for the revision. Discussion only. End with "VERDICT: APPROVE" (if you are now convinced the current version meets the bar) or "VERDICT: REVISE".`,
    revision: (author: string, reply: string, n: number) =>
      `"${author}"'s latest response to your review:\n\n<reply>\n${reply}\n</reply>\n\nNow revise it yourself and output version ${n} as a **complete** deliverable inside <deliverable></deliverable>. Adopt the improvements you both agreed on; use your best judgment on unresolved points, and briefly note outside the tags what changed and why.`,
    s_draft: (a: string) => `"${a}" is working on the task (version 1)…`,
    s_review: (r: number, who: string, n: number) => `Round ${r}: "${who}" reviews version ${n}…`,
    s_approved: (r: number, who: string, n: number) => `Round ${r}: "${who}" approved version ${n}. Done.`,
    s_reply: (r: number, t: number, T: number, who: string) => `Round ${r} discussion ${t}/${T}: "${who}" responds to the review…`,
    s_counter: (r: number, t: number, T: number, who: string) => `Round ${r} discussion ${t}/${T}: "${who}" continues the discussion…`,
    s_approved2: (r: number, who: string, n: number) => `Round ${r}: after discussion, "${who}" approved version ${n}. Done.`,
    s_revise: (r: number, who: string, n: number) => `Round ${r}: "${who}" revises based on the discussion → version ${n}…`,
    s_max: (m: number, n: number) => `Reached the maximum of ${m} rounds; version ${n} is the final deliverable.`,
    mediaRule: (images: boolean, videos: boolean) => {
      const kinds = [images ? "an image" : "", videos ? "a video" : ""].filter(Boolean).join(" or ");
      const lines = [`6. When the deliverable needs ${kinds}, do not write "image goes here": request it with a fenced block. The system generates it and replaces the block with an ![description](media://…) reference that the other agent and the user can see.`];
      if (images) lines.push(`   Image: \`\`\`image aspect=16:9 (1:1 / 16:9 / 9:16; optional quality=low|medium|high), then from the next line a complete, concrete description (subject, scene, style, lighting, composition), closed with \`\`\`.`);
      if (videos) lines.push(`   Video: \`\`\`video seconds=8 aspect=16:9 (seconds 4 / 8 / 12), then the shot and scene description.`);
      lines.push(`   When revising, keep existing ![…](media://…) references as they are; write a new block only for a new or different picture. At most ${MEDIA_LIMITS.perMessageImages} images and ${MEDIA_LIMITS.perMessageVideos} video per message; at most ${MEDIA_LIMITS.perRunImages} images and ${MEDIA_LIMITS.perRunVideos} videos in the whole run.${!videos ? " Video generation is off." : ""}${!images ? " Image generation is off." : ""}`);
      return lines.join("\n");
    },
  },
};

class Agent {
  key: AgentKey;
  cfg: AgentConfig;
  system: string;
  turns: Turn[] = [];
  currentId = "";
  backend: Backend;
  private emit: Emit;
  private signal: AbortSignal;
  private lang: Lang;
  private cwd: string;
  private media: MediaRun | null;

  constructor(key: AgentKey, cfg: AgentConfig, system: string, emit: Emit, signal: AbortSignal, lang: Lang, cwd: string, backend?: Backend, media: MediaRun | null = null) {
    this.key = key; this.cfg = cfg; this.system = system; this.emit = emit; this.signal = signal; this.lang = lang; this.cwd = cwd; this.media = media;
    this.backend = backend ?? createBackend(cfg.agent.runner, {
      emit: (ev) => this.emit({ ...ev, id: this.currentId, agent: this.key, name: this.cfg.name }),
    });
  }

  async say(kind: Kind, round: number, userText: string, repositoryAccess?: "read-only" | "write", forceRevision = false): Promise<string> {
    assertActive(this.signal);
    this.turns.push({ role: "user", text: userText });
    const id = `${this.key}-${round}-${kind}-${Date.now()}`;
    this.currentId = id;
    const m = this.cfg.agent.model; const modelLabel = typeof m === "string" ? m : m[this.lang];
    const ttl = this.cfg.agent.title; const source = typeof ttl === "string" ? ttl : ttl[this.lang];
    this.emit({ type: "message_start", id, agent: this.key, name: this.cfg.name, model: modelLabel, source, kind, round });
    const res = await this.backend.chat({
      system: this.system, turns: this.turns, lang: this.lang, cwd: this.cwd, signal: this.signal, repositoryAccess,
      onDelta: (text) => this.emit({ type: "delta", id, text }),
      onProgress: (p) => this.emit({ type: "progress", id, ...p }),
    });
    assertActive(this.signal);
    // 媒体围栏 → 生成 → 替换为引用；替换后的正文进入双方后续对话与成果
    let text = res.text;
    if (this.media) {
      try { text = await processMedia(res.text, this.media, id, (ev) => this.emit(ev)); }
      catch (e: any) { if (this.signal.aborted) throw e; this.emit({ type: "status", text: String(e?.message ?? e) }); }
    }
    this.turns.push({ role: "assistant", text });
    const verdict = kind === "review" || kind === "counter" ? (forceRevision ? "revise" : parseVerdict(text)) : undefined;
    this.emit({ type: "message_end", id, verdict, model: res.model, usage: res.usage, ...(text !== res.text ? { text } : {}) });
    return text;
  }
}

export interface RunResult {
  versions: { n: number; agent: AgentKey; name: string; content: string }[];
  finalVersion: number;
  reason: string;
  approved: boolean;   // 最终版是否经审查者判定「通过」（false = 达到最大轮数）
  media: MediaRecord[];   // 本次协作生成的图片 / 视频
  repository?: RepositoryManifest;
}

export async function runCollaboration(
  cfg: RunConfig, emit: Emit, signal: AbortSignal,
  backends?: { A: Backend; B: Backend },   // 仅用于测试注入
): Promise<RunResult> {
  assertActive(signal);
  if (cfg.repository) return runRepositoryCollaboration(cfg, emit, signal, backends);
  const T = P[cfg.lang];
  const m = cfg.media && (cfg.media.images || cfg.media.videos) ? cfg.media : null;
  const mediaRun = m ? newMediaRun(m.provider, m.dir, cfg.lang, signal, { images: m.images, videos: m.videos }) : null;
  const rule = m ? T.mediaRule(m.images, m.videos) : "";
  const A = new Agent("A", cfg.agentA, T.system(cfg.agentA.name, cfg.agentB.name, cfg.agentA.persona, cfg.task, rule), emit, signal, cfg.lang, cfg.cwd, backends?.A, mediaRun);
  const B = new Agent("B", cfg.agentB, T.system(cfg.agentB.name, cfg.agentA.name, cfg.agentB.persona, cfg.task, rule), emit, signal, cfg.lang, cfg.cwd, backends?.B, mediaRun);

  const versions: RunResult["versions"] = [];
  const pushVersion = (agent: Agent, content: string) => {
    const v = { n: versions.length + 1, agent: agent.key, name: agent.cfg.name, content };
    versions.push(v);
    emit({ type: "version", ...v });
    return v;
  };

  emit({ type: "status", text: T.s_draft(A.cfg.name) });
  const draft = await A.say("draft", 0, T.draft());
  let current = pushVersion(A, extractDeliverable(draft));

  let author = A, reviewer = B, reason = "", approved = false;

  for (let round = 1; round <= cfg.maxRounds; round++) {
    emit({ type: "status", text: T.s_review(round, reviewer.cfg.name, current.n) });
    const review = await reviewer.say("review", round, T.review(author.cfg.name, current.n, current.content));
    let verdict = parseVerdict(review);
    if (verdict === "approve") {
      reason = T.s_approved(round, reviewer.cfg.name, current.n); approved = true;
      emit({ type: "status", text: reason });
      break;
    }

    let lastReviewerMsg = review, lastAuthorMsg = "";
    for (let t = 1; t <= cfg.discussionTurns; t++) {
      emit({ type: "status", text: T.s_reply(round, t, cfg.discussionTurns, author.cfg.name) });
      lastAuthorMsg = await author.say("reply", round, T.reply(reviewer.cfg.name, current.n, lastReviewerMsg));
      if (t < cfg.discussionTurns) {
        emit({ type: "status", text: T.s_counter(round, t, cfg.discussionTurns, reviewer.cfg.name) });
        lastReviewerMsg = await reviewer.say("counter", round, T.counter(author.cfg.name, lastAuthorMsg));
        if (parseVerdict(lastReviewerMsg) === "approve") { verdict = "approve"; break; }
      }
    }
    if (verdict === "approve") {
      reason = T.s_approved2(round, reviewer.cfg.name, current.n); approved = true;
      emit({ type: "status", text: reason });
      break;
    }

    emit({ type: "status", text: T.s_revise(round, reviewer.cfg.name, current.n + 1) });
    const revision = await reviewer.say("revision", round, T.revision(author.cfg.name, lastAuthorMsg, current.n + 1));
    current = pushVersion(reviewer, extractDeliverable(revision));
    [author, reviewer] = [reviewer, author];
  }

  if (!reason) {
    reason = T.s_max(cfg.maxRounds, current.n);
    emit({ type: "status", text: reason });
  }
  emit({ type: "done", reason, finalVersion: current.n });
  return { versions, finalVersion: current.n, reason, approved, media: mediaRun?.records ?? [] };
}

/** Repository mode shares a task worktree and hands write access to one author at a time. */
async function runRepositoryCollaboration(cfg: RunConfig, emit: Emit, signal: AbortSignal, backends?: { A: Backend; B: Backend }): Promise<RunResult> {
  for (const agent of [cfg.agentA, cfg.agentB]) {
    if (agent.agent.kind !== "cli" || !["claude-code", "codex", "kimi-code"].includes(agent.agent.runner.type)) {
      throw new Error("仓库协作必须为两位 Agent 选择 Kimi Code、Codex 或 Claude Code 命令行；API、桌面中转与其他 CLI 暂不支持文件工具");
    }
  }
  if (cfg.media) throw new Error("仓库协作模式暂不支持媒体生成，请使用文字协作模式生成图片或视频");
  const workspace = await prepareRepository(cfg.repository!, signal);
  const manifest = workspace.manifest;
  const zh = cfg.lang === "zh";
  const versions: RunResult["versions"] = [];
  const instructions = (self: AgentConfig, other: AgentConfig) => zh ? [
    `你是 ${self.name}，与 ${other.name} 轮流实现和审查用户的代码任务。`,
    `当前目录 ${manifest.worktreePath} 是隔离的任务 Git worktree，初始版本 ${manifest.baseCommit}。请先阅读仓库说明及相关文件。`,
    "作者阶段：使用文件工具直接修改当前目录内的文件；回答简要列出修改及原因，不必输出完整文件内容。",
    "审查和讨论阶段：只允许读取文件，不得修改、提交或执行可能写文件的命令。按严重程度列出可操作问题与位置，末尾单独一行写【结论】通过或【结论】需修改。",
    "只在当前 worktree 中操作。不要切分支、创建提交、修改 Git 元数据、合并、推送、访问或修改原始仓库；快照由协作程序保存。不要绕过工具权限。",
    "本任务的校验命令由程序执行。审查必须核对校验结果；失败结果未修复前不能通过。未配置校验时，明确说明尚未运行自动测试。",
    self.persona ? `额外关注点：${self.persona}` : "", `用户任务：\n${cfg.task}`,
  ].filter(Boolean).join("\n") : [
    `You are ${self.name}, alternating implementation and review with ${other.name}.`,
    `Your current directory ${manifest.worktreePath} is an isolated task Git worktree at base ${manifest.baseCommit}. Read repository guidance and relevant files first.`,
    "Author phase: edit actual files in the current worktree using file tools. Reply with a concise change summary; full file listings are unnecessary.",
    'Review and discussion phases: read files only, with no file edits, commits or commands that can write. Report actionable findings by severity and location. End with a line "VERDICT: APPROVE" or "VERDICT: REVISE".',
    "Stay inside this worktree. Do not switch branches, create commits, alter Git metadata, merge, push, or access/change the source checkout. The application owns Git checkpoints. Do not bypass tool permissions.",
    "The application runs configured validation commands. Inspect their results; unresolved check failures prevent approval. If no checks were configured, clearly state that automated tests were not run.",
    self.persona ? `Additional focus: ${self.persona}` : "", `User task:\n${cfg.task}`,
  ].filter(Boolean).join("\n");
  const A = new Agent("A", cfg.agentA, instructions(cfg.agentA, cfg.agentB), emit, signal, cfg.lang, manifest.worktreePath, backends?.A);
  const B = new Agent("B", cfg.agentB, instructions(cfg.agentB, cfg.agentA), emit, signal, cfg.lang, manifest.worktreePath, backends?.B);
  const T = P[cfg.lang];
  let author = A, reviewer = B;
  let approved = false, reason = "";
  const writeVersion = async (agent: Agent, kind: "draft" | "revision", round: number, prompt: string) => {
    assertActive(signal);
    await workspace.assertReadOnly(signal);
    const summary = await agent.say(kind, round, prompt, "write");
    const n = versions.length + 1;
    const checks = await workspace.runChecks(n, signal, (check) => emit({ type: "repository_check", check }));
    const snapshot = await workspace.snapshot(n, agent.key, summary, checks, signal);
    emit({ type: "repository_snapshot", snapshot });
    const content = `${summary}\n\n${zh ? "提交" : "Commit"}: ${snapshot.commit}\n\n${snapshot.stat || (zh ? "本轮未修改文件。" : "No file changes in this version.")}`;
    const version = { n, agent: agent.key, name: agent.cfg.name, content };
    versions.push(version); emit({ type: "version", ...version }); return snapshot;
  };
  const readOnly = async (agent: Agent, kind: "review" | "reply" | "counter", round: number, prompt: string, forceRevision = false) => {
    await workspace.assertReadOnly(signal);
    const answer = await agent.say(kind, round, prompt, "read-only", forceRevision);
    await workspace.assertReadOnly(signal); return answer;
  };
  try {
    emit({ type: "repository_ready", repository: structuredClone(manifest) });
    emit({ type: "status", text: zh ? `任务分支 ${manifest.branch} 已创建；两位 Agent 将轮流在隔离目录中修改文件。` : `Task branch ${manifest.branch} created; the agents will edit the isolated worktree in turn.` });
    let current = await writeVersion(author, "draft", 0, zh ? "请阅读当前仓库，直接编辑文件完成用户任务，然后简述修改和待验证内容。" : "Read the repository, edit files to implement the task, and summarize the changes and remaining validation.");
    for (let round = 1; round <= cfg.maxRounds; round++) {
      emit({ type: "status", text: T.s_review(round, reviewer.cfg.name, current.n) });
      const report = current.checks.length ? JSON.stringify(current.checks, null, 2) : zh ? "未配置校验命令，未运行自动测试。" : "No validation commands were configured; automated tests were not run.";
      const failures = current.checks.some((c) => !c.ok);
      // Claude's restricted review tools cannot run Git. Supply the actual
      // cumulative patch so both CLI reviewers can compare original and new code.
      const cumulativeDiff = await readRepositoryDiff(manifest.worktreePath, manifest.baseCommit, current.commit, signal);
      const diffLimit = 120_000;
      const truncated = cumulativeDiff.length > diffLimit;
      const diff = cumulativeDiff.slice(0, diffLimit) || (zh ? "没有文件改动。" : "No file changes.");
      const diffNote = truncated
        ? (zh ? "补丁超过 120000 字符，以下内容已截断。请按需只读查看当前文件以完成审查，不要把缺失片段当作没有改动。" : "The patch exceeds 120000 characters and is truncated below. Read current files as needed to complete the review; omitted sections may contain changes.")
        : (zh ? "以下是从原始基线到当前版本的实际累计 Git 补丁：" : "Actual cumulative Git patch from the original base to the current version:");
      const diffContext = `${diffNote}\n<repository_diff>\n${diff}\n</repository_diff>`;
      const reviewPrompt = zh
        ? `请只读审查实际文件和第 ${current.n} 版改动。基线 ${manifest.baseCommit}，当前提交 ${current.commit}。\n作者摘要：\n${current.summary}\n\n本轮变更：\n${current.stat}\n\n${diffContext}\n\n程序校验结果：\n${report}\n\n核对用户任务，指出具体问题，给出通过或需修改结论。`
        : `Read-only review of the actual files and version ${current.n}. Base ${manifest.baseCommit}; current commit ${current.commit}.\nAuthor summary:\n${current.summary}\n\nChanges:\n${current.stat}\n\n${diffContext}\n\nValidation results:\n${report}\n\nCheck against the user task and give an explicit verdict.`;
      let review = await readOnly(reviewer, "review", round, reviewPrompt, failures);
      let verdict = parseVerdict(review);
      if (failures) verdict = "revise";
      if (verdict === "approve") { approved = true; reason = T.s_approved(round, reviewer.cfg.name, current.n); break; }
      let reply = "";
      for (let turn = 1; turn <= cfg.discussionTurns; turn++) {
        reply = await readOnly(author, "reply", round, `${T.reply(reviewer.cfg.name, current.n, review)}\n${failures ? (zh ? "校验仍失败，当前版本不能通过。" : "Validation still fails; the current version cannot be approved.") : ""}`);
        if (turn < cfg.discussionTurns) {
          review = await readOnly(reviewer, "counter", round, T.counter(author.cfg.name, reply), failures);
          if (!failures && parseVerdict(review) === "approve") { approved = true; reason = T.s_approved2(round, reviewer.cfg.name, current.n); break; }
        }
      }
      if (approved || round === cfg.maxRounds) break;
      emit({ type: "status", text: T.s_revise(round, reviewer.cfg.name, current.n + 1) });
      const prompt = zh
        ? `现在由你担任作者。根据审查意见、讨论和校验失败直接修改当前文件，产生第 ${current.n + 1} 版。\n审查意见：\n${review}\n\n对方回应：\n${reply}\n\n校验结果：\n${report}\n\n完成后简述修改。不要自行提交、切分支、合并或推送。`
        : `You are the author now. Edit files to address the review, discussion and failed checks for version ${current.n + 1}.\nReview:\n${review}\n\nOther agent's response:\n${reply}\n\nValidation:\n${report}\n\nSummarize your edits. Do not commit, switch branches, merge or push.`;
      current = await writeVersion(reviewer, "revision", round, prompt);
      [author, reviewer] = [reviewer, author];
    }
    if (!reason) reason = zh ? `已达到最大审查轮数（${cfg.maxRounds}），第 ${current.n} 版尚未通过。改动保留在任务分支，待人工检查。` : `Reached ${cfg.maxRounds} review rounds; version ${current.n} has not passed. Changes remain on the task branch for inspection.`;
    assertActive(signal);
    await workspace.close(approved ? "approved" : "max_rounds");
    emit({ type: "status", text: reason }); emit({ type: "done", reason, finalVersion: current.n });
    return { versions, finalVersion: current.n, reason, approved, media: [], repository: manifest };
  } catch (e: any) {
    await workspace.close(signal.aborted ? "cancelled" : "failed", String(e?.message ?? e));
    throw e;
  }
}
