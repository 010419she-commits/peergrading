// Sessions are journaled before they are sent to the browser. A checkpoint owns
// all sequences up to lastSequence, so a crash between rename and journal
// truncation cannot replay an event twice.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Event, RunConfig, RunResult } from "./orchestrator.ts";

export type SessionStatus = "running" | "completed" | "cancelled" | "failed" | "interrupted";
export interface SavedSession {
  id: string;
  userId: number;
  config: any;
  result: (RunResult & { partial?: boolean }) | null;
  events: Event[];
  versionIds: Record<number, string>;
  status: SessionStatus;
  partial: boolean;
  createdAt: string;
  updatedAt: string;
  lastSequence?: number;
  formatVersion?: number;
}

export const LOCAL_OWNER_ID = 1;
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 8192;
const JOURNAL_CHECKPOINT_BYTES = 256 * 1024;
// A final result duplicates version text retained in events, plus display config.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CHECKPOINT_EVENTS = new Set(["status", "message_start", "message_end", "version", "repository_ready", "repository_snapshot", "repository_check", "done", "error"]);

export class SessionCorruptError extends Error {
  constructor(message: string) { super(message); this.name = "SessionCorruptError"; }
}
export class SessionLimitError extends Error {
  constructor() { super("Session history reached its storage limit; completed work has been preserved."); this.name = "SessionLimitError"; }
}

function directory(root: string, id: string): string {
  if (!ID.test(id)) throw new Error("invalid_session_id");
  return path.join(root, id);
}
function readBounded(file: string): string {
  if (fs.statSync(file).size > MAX_FILE_BYTES) throw new SessionCorruptError("Session file exceeds its size limit.");
  return fs.readFileSync(file, "utf8");
}
function safeAgent(slot: RunConfig["agentA"]) {
  const info = slot.agent;
  // Keep display metadata only. In particular, never serialize runner objects,
  // endpoint credentials, provider instances, or future connection settings.
  return { name: slot.name, persona: slot.persona, agent: {
    id: info.id, kind: info.kind, title: info.title, subtitle: info.subtitle,
    model: info.model, local: info.local, deployment: info.deployment, status: info.status, auto: info.auto, icon: info.icon,
  } };
}
export function safeSessionConfig(cfg: RunConfig) {
  return { task: cfg.task, lang: cfg.lang, cwd: cfg.cwd, maxRounds: cfg.maxRounds, discussionTurns: cfg.discussionTurns,
    agentA: safeAgent(cfg.agentA), agentB: safeAgent(cfg.agentB),
    ...(cfg.repository ? { repository: { path: cfg.repository.path, sessionDir: cfg.repository.sessionDir,
      checks: cfg.repository.checks?.map((c) => ({ argv: [...c.argv], timeoutMs: c.timeoutMs })) } } : {}),
    ...(cfg.media ? { media: { images: cfg.media.images, videos: cfg.media.videos } } : {}),
    ...(cfg.acceleration ? { acceleration: {
      speculativeReview: cfg.acceleration.speculativeReview === true,
      cache: cfg.acceleration.cache === true,
    } } : {}),
  };
}

class EventHistory {
  events: Event[] = [];
  bytes = 0;
  private deltas = new Map<string, number>();
  constructor(events: Event[] = []) { for (const ev of events) this.add(ev); }
  add(raw: Event) {
    // Progress ticks add no recoverable text; a single delta per message retains
    // the transcript without retaining thousands of token-sized event objects.
    if (raw.type === "progress" || raw.type === "media_progress") return;
    const ev = JSON.parse(JSON.stringify(raw)) as Event;
    const index = ev.type === "delta" ? this.deltas.get(ev.id) : undefined;
    const extra = index === undefined ? Buffer.byteLength(JSON.stringify(ev)) : Buffer.byteLength(JSON.stringify((ev as any).text)) - 2;
    const terminal = ev.type === "error" || ev.type === "done";
    if (this.bytes + extra > MAX_BYTES + (terminal ? 4096 : 0) || (index === undefined && this.events.length >= MAX_EVENTS + (terminal ? 2 : 0))) throw new SessionLimitError();
    if (index !== undefined) (this.events[index] as Extract<Event, { type: "delta" }>).text += (ev as Extract<Event, { type: "delta" }>).text;
    else {
      if (ev.type === "delta") this.deltas.set(ev.id, this.events.length);
      this.events.push(ev);
    }
    this.bytes += extra;
  }
}

function partialResult(events: Event[]): (RunResult & { partial: true }) | null {
  const versions: RunResult["versions"] = [];
  for (const ev of events) if (ev.type === "version") {
    const v = { n: ev.n, agent: ev.agent, name: ev.name, content: ev.content };
    const index = versions.findIndex((existing) => existing.n === v.n);
    if (index >= 0) versions[index] = v; else versions.push(v);
  }
  if (!versions.length) return null;
  versions.sort((a, b) => a.n - b.n);
  return { versions, finalVersion: versions.at(-1)!.n, reason: "Run did not finish; completed versions were preserved.", approved: false, media: [], partial: true };
}

/** No Agent is restarted by reading a session. Active state is process-local. */
export function readSession(root: string, id: string, activeOrLegacyUserId: boolean | number = false, legacyActive = false): SavedSession | null {
  const active = typeof activeOrLegacyUserId === "boolean" ? activeOrLegacyUserId : legacyActive;
  if (!ID.test(id)) return null;
  const dir = directory(root, id), file = path.join(dir, "session.json");
  if (!fs.existsSync(file)) return null;
  let saved: SavedSession;
  try { saved = JSON.parse(readBounded(file)); }
  catch (e) { if (e instanceof SessionCorruptError) throw e; throw new SessionCorruptError("Session checkpoint is not valid JSON."); }
  if (!saved.config || !Array.isArray(saved.events)) throw new SessionCorruptError("Session checkpoint is missing its transcript.");
  let history: EventHistory;
  try { history = new EventHistory(saved.events); }
  catch { throw new SessionCorruptError("Session checkpoint transcript exceeds its limits."); }
  let sequence = Number(saved.lastSequence) || 0;
  const journal = path.join(dir, "events.jsonl");
  if (saved.formatVersion === 1 && fs.existsSync(journal)) {
    const content = readBounded(journal), lines = content.split("\n");
    let prior = 0;
    for (let i = 0; i < lines.length; i++) {
      if (i === lines.length - 1 && lines[i] === "") break;
      let entry: { seq: number; event: Event; at: string };
      try { entry = JSON.parse(lines[i]); }
      catch {
        // Only an unterminated final write is recoverable. Damage to any
        // newline-terminated record is reported instead of silently skipped.
        if (i === lines.length - 1 && !content.endsWith("\n")) break;
        throw new SessionCorruptError(`Session journal is damaged at line ${i + 1}.`);
      }
      if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || entry.seq <= prior || !entry.event || typeof entry.event.type !== "string") throw new SessionCorruptError(`Session journal has an invalid record at line ${i + 1}.`);
      prior = entry.seq;
      if (entry.seq <= sequence) continue;
      if (entry.seq !== sequence + 1) throw new SessionCorruptError("Session journal is missing an event.");
      try { history.add(entry.event); } catch { throw new SessionCorruptError("Session journal transcript exceeds its limits."); }
      sequence = entry.seq;
      if (typeof entry.at === "string") saved.updatedAt = entry.at;
    }
  }
  saved.events = history.events;
  saved.lastSequence = sequence;
  saved.versionIds ||= {};
  saved.status ||= saved.result ? "completed" : saved.events.some((ev) => ev.type === "error") ? "failed" : "interrupted";
  if (saved.status === "running" && !active) saved.status = "interrupted";
  if (!saved.result) saved.result = partialResult(saved.events);
  saved.partial = !!saved.result?.partial || (!saved.result && saved.status !== "completed");
  return saved;
}

export function listSessions(root: string, _legacyUserId?: number): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((id) => {
    if (!ID.test(id)) return false;
    const file = path.join(root, id, "session.json");
    try {
      const saved = JSON.parse(readBounded(file));
      return !!saved && typeof saved === "object" && !Array.isArray(saved) && !!saved.config && Array.isArray(saved.events);
    } catch { return false; }
  }).sort().reverse();
}

export class SessionStore {
  private dir: string;
  private record: SavedSession;
  private history = new EventHistory();
  private journalBytes = 0;
  constructor(root: string, id: string, cfg: RunConfig) {
    this.dir = directory(root, id);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(path.join(this.dir, "session.json"))) throw new Error("session_already_exists");
    const now = new Date().toISOString();
    this.record = { id, userId: LOCAL_OWNER_ID, config: safeSessionConfig(cfg), result: null, events: this.history.events, versionIds: {}, status: "running", partial: true, createdAt: now, updatedAt: now, formatVersion: 1, lastSequence: 0 };
    if (Buffer.byteLength(JSON.stringify(this.record.config)) > 512 * 1024) throw new SessionLimitError();
    this.checkpoint();
  }
  append(ev: Event) {
    if (ev.type === "progress" || ev.type === "media_progress") return;
    // Validate the bounded update before committing its journal record.
    this.history.add(ev);
    const sequence = this.record.lastSequence! + 1, at = new Date().toISOString();
    const line = JSON.stringify({ seq: sequence, at, event: ev }) + "\n";
    fs.appendFileSync(path.join(this.dir, "events.jsonl"), line, { mode: 0o600 });
    this.record.lastSequence = sequence; this.record.updatedAt = at;
    this.journalBytes += Buffer.byteLength(line);
    if (CHECKPOINT_EVENTS.has(ev.type) || this.journalBytes >= JOURNAL_CHECKPOINT_BYTES) this.checkpoint();
  }
  partialResult(): RunResult | null { return partialResult(this.history.events); }
  finish(status: "completed" | "cancelled" | "failed", result: RunResult | null, versionIds: Record<number, string> = {}) {
    this.record.status = status; this.record.result = result ?? partialResult(this.history.events);
    this.record.partial = !result; this.record.versionIds = versionIds;
    this.record.updatedAt = new Date().toISOString(); this.checkpoint();
  }
  private checkpoint() {
    const file = path.join(this.dir, "session.json"), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.record), { mode: 0o600, flush: true });
      fs.renameSync(temporary, file);
      fs.writeFileSync(path.join(this.dir, "events.jsonl"), "", { mode: 0o600 });
      this.journalBytes = 0;
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
}
