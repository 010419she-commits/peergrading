// orchestrator.ts — 双 Agent「作者 / 审查者」轮换协作循环（后端无关）
import type { AgentInfo, Backend, Lang, Turn } from "./agents/types.ts";
import { createBackend } from "./agents/backends.ts";
import { newMediaRun, processMedia, MEDIA_LIMITS, type MediaEvent, type MediaProvider, type MediaRecord, type MediaRun } from "./agents/media.ts";

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

  async say(kind: Kind, round: number, userText: string): Promise<string> {
    this.turns.push({ role: "user", text: userText });
    const id = `${this.key}-${round}-${kind}-${Date.now()}`;
    this.currentId = id;
    const m = this.cfg.agent.model; const modelLabel = typeof m === "string" ? m : m[this.lang];
    const ttl = this.cfg.agent.title; const source = typeof ttl === "string" ? ttl : ttl[this.lang];
    this.emit({ type: "message_start", id, agent: this.key, name: this.cfg.name, model: modelLabel, source, kind, round });
    const res = await this.backend.chat({
      system: this.system, turns: this.turns, lang: this.lang, cwd: this.cwd, signal: this.signal,
      onDelta: (text) => this.emit({ type: "delta", id, text }),
      onProgress: (p) => this.emit({ type: "progress", id, ...p }),
    });
    // 媒体围栏 → 生成 → 替换为引用；替换后的正文进入双方后续对话与成果
    let text = res.text;
    if (this.media) {
      try { text = await processMedia(res.text, this.media, id, (ev) => this.emit(ev)); }
      catch (e: any) { if (this.signal.aborted) throw e; this.emit({ type: "status", text: String(e?.message ?? e) }); }
    }
    this.turns.push({ role: "assistant", text });
    const verdict = kind === "review" || kind === "counter" ? parseVerdict(text) : undefined;
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
}

export async function runCollaboration(
  cfg: RunConfig, emit: Emit, signal: AbortSignal,
  backends?: { A: Backend; B: Backend },   // 仅用于测试注入
): Promise<RunResult> {
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
