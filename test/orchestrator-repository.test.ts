import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runCollaboration, type RunConfig, type Event } from "../orchestrator.ts";
import type { Backend, ChatRequest } from "../agents/types.ts";
import { prepareRepository } from "../repository/workspace.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pg-orch-repo-"));
after(() => fs.rm(temporary, { recursive: true, force: true }));
function git(cwd: string, args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
const agent = (name: string) => ({ name, persona: "", agent: { id: name, kind: "cli", title: name, subtitle: "", model: "fake", local: true, status: "ready", auto: true, runner: { type: "codex", bin: "unused" }, icon: "" } as any });
async function fixture(name: string): Promise<RunConfig> {
  const repo = path.join(temporary, name); await fs.mkdir(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "Test"]); git(repo, ["config", "user.email", "test@example.invalid"]);
  await fs.writeFile(path.join(repo, "app.txt"), "original\n"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "baseline"]);
  return { task: "Improve app.txt", lang: "en", agentA: agent("A"), agentB: agent("B"), maxRounds: 2, discussionTurns: 1, cwd: repo,
    repository: { path: repo, sessionDir: path.join(temporary, `${name}-session`) } };
}
function backend(action: (req: ChatRequest) => Promise<string> | string): Backend & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  return { seen, async chat(req) { seen.push({ ...req, turns: req.turns.map((t) => ({ ...t })) }); const text = await action(req); req.onDelta(text); return { text }; } };
}

test("two file-tool agents alternate authorship, review actual checkpoints and leave source unmerged", async () => {
  const cfg = await fixture("alternate");
  cfg.repository!.checks = [{ argv: [process.execPath, "-e", `const fs=require('fs'); if(fs.readFileSync('app.txt','utf8').trim()!=='fixed')process.exit(1)`] }];
  const A = backend(async (req) => {
    if (req.repositoryAccess === "write") { await fs.writeFile(path.join(req.cwd, "app.txt"), "first try\n"); return "Initial edits"; }
    return req.turns.at(-1)!.text.includes("Read-only review") ? "VERDICT: APPROVE" : "Please address the failed check.";
  });
  // A false approval cannot bypass the explicit failing check in version 1.
  const B = backend(async (req) => {
    if (req.repositoryAccess === "write") { await fs.writeFile(path.join(req.cwd, "app.txt"), "fixed\n"); return "Fixed the check"; }
    return "VERDICT: APPROVE";
  });
  const events: Event[] = []; const original = git(cfg.cwd, ["rev-parse", "HEAD"]);
  const result = await runCollaboration(cfg, (e) => events.push(e), new AbortController().signal, { A, B });
  assert.equal(result.approved, true); assert.equal(result.finalVersion, 2); assert.equal(result.repository!.status, "approved");
  assert.deepEqual(result.versions.map((v) => v.agent), ["A", "B"]);
  assert.deepEqual(A.seen.map((r) => r.repositoryAccess), ["write", "read-only", "read-only"]);
  assert.deepEqual(B.seen.map((r) => r.repositoryAccess), ["read-only", "write"]);
  assert.equal(result.repository!.snapshots[0].checks[0].ok, false); assert.equal(result.repository!.snapshots[1].checks[0].ok, true);
  assert.match(B.seen[0].turns.at(-1)!.text, /"code": 1/);
  assert.match(B.seen[0].turns.at(-1)!.text, /<repository_diff>[\s\S]*diff --git a\/app\.txt b\/app\.txt[\s\S]*-original\n\+first try/);
  assert.match(A.seen.at(-1)!.turns.at(-1)!.text, /<repository_diff>[\s\S]*-original\n\+fixed/,
    "later reviews receive the cumulative patch from the original base, including actual old and new code");
  assert.ok(A.seen.every((r) => r.cwd === result.repository!.worktreePath));
  assert.equal(await fs.readFile(path.join(cfg.cwd, "app.txt"), "utf8"), "original\n");
  assert.equal(git(cfg.cwd, ["rev-parse", "HEAD"]), original); assert.equal(git(cfg.cwd, ["status", "--porcelain"]), "");
  assert.equal(await fs.readFile(path.join(result.repository!.worktreePath, "app.txt"), "utf8"), "fixed\n");
  assert.equal(events.filter((e) => e.type === "repository_snapshot").length, 2);
  assert.equal(events.filter((e) => e.type === "repository_check").length, 2);
  const firstReview = events.find((e) => e.type === "message_end" && e.id.includes("review")) as any;
  assert.equal(firstReview.verdict, "revise", "The UI verdict must reflect the failed check veto");
});

test("review permission violation stops the run and preserves evidence without modifying source", async () => {
  const cfg = await fixture("read-only");
  const A = backend(async (req) => { await fs.writeFile(path.join(req.cwd, "app.txt"), "author\n"); return "Edited"; });
  const B = backend(async (req) => { assert.equal(req.repositoryAccess, "read-only"); await fs.writeFile(path.join(req.cwd, "app.txt"), "reviewer illegally wrote\n"); return "VERDICT: APPROVE"; });
  await assert.rejects(runCollaboration(cfg, () => {}, new AbortController().signal, { A, B }), /审查或讨论阶段意外修改/);
  const manifest = JSON.parse(await fs.readFile(path.join(cfg.repository!.sessionDir, "repository", "manifest.json"), "utf8"));
  assert.equal(manifest.status, "failed"); assert.equal(manifest.snapshots.length, 1);
  assert.equal(await fs.readFile(path.join(manifest.worktreePath, "app.txt"), "utf8"), "reviewer illegally wrote\n");
  assert.equal(await fs.readFile(path.join(cfg.cwd, "app.txt"), "utf8"), "original\n");
  const another = await prepareRepository({ path: cfg.cwd, sessionDir: path.join(temporary, "violation-next") }, new AbortController().signal); await another.close("cancelled");
});

test("cancellation preserves partial writes and releases the repository lock", async () => {
  const cfg = await fixture("abort"); const controller = new AbortController();
  const A = backend(async (req) => { await fs.writeFile(path.join(req.cwd, "partial.txt"), "partial"); controller.abort(); return "Cancelled"; });
  const B = backend(() => { throw new Error("Must not be invoked"); });
  await assert.rejects(runCollaboration(cfg, () => {}, controller.signal, { A, B }), /aborted/);
  const manifest = JSON.parse(await fs.readFile(path.join(cfg.repository!.sessionDir, "repository", "manifest.json"), "utf8"));
  assert.equal(manifest.status, "cancelled"); assert.equal(manifest.snapshots.length, 0);
  assert.equal(await fs.readFile(path.join(manifest.worktreePath, "partial.txt"), "utf8"), "partial");
  const next = await prepareRepository({ path: cfg.cwd, sessionDir: path.join(temporary, "abort-next") }, new AbortController().signal); await next.close("cancelled");
});

test("CLI failure preserves its worktree and a max-round stop never emits an unreviewed extra version", async () => {
  const cfg = await fixture("failure");
  const A = backend(async (req) => { await fs.writeFile(path.join(req.cwd, "app.txt"), "partial edit\n"); throw new Error("CLI exit 2"); });
  const B = backend(() => "VERDICT: REVISE");
  await assert.rejects(runCollaboration(cfg, () => {}, new AbortController().signal, { A, B }), /CLI exit 2/);
  const manifest = JSON.parse(await fs.readFile(path.join(cfg.repository!.sessionDir, "repository", "manifest.json"), "utf8"));
  assert.equal(manifest.status, "failed"); assert.equal(await fs.readFile(path.join(manifest.worktreePath, "app.txt"), "utf8"), "partial edit\n");
  const one = await fixture("limit"); one.maxRounds = 1; one.discussionTurns = 0;
  const result = await runCollaboration(one, () => {}, new AbortController().signal, { A: backend(() => "Nothing changed"), B });
  assert.equal(result.approved, false); assert.equal(result.finalVersion, 1); assert.equal(result.repository!.status, "max_rounds");
});

test("unsupported agents are rejected before creating worktrees", async () => {
  const cfg = await fixture("unsupported"); cfg.agentB.agent.kind = "relay";
  await assert.rejects(runCollaboration(cfg, () => {}, new AbortController().signal), /必须为两位 Agent 选择/);
  assert.equal(git(cfg.cwd, ["branch", "--list", "codex/*"]), "");
});

test("large review patches are bounded and explicitly identify omitted changes", async () => {
  const cfg = await fixture("large-diff"); cfg.maxRounds = 1;
  const A = backend(async (req) => { await fs.writeFile(path.join(req.cwd, "app.txt"), "start\n" + "x".repeat(130_000) + "\nend\n"); return "Updated app.txt"; });
  const B = backend(() => "VERDICT: APPROVE");
  const result = await runCollaboration(cfg, () => {}, new AbortController().signal, { A, B });
  assert.equal(result.approved, true);
  const prompt = B.seen[0].turns.at(-1)!.text;
  assert.match(prompt, /patch exceeds 120000 characters and is truncated/);
  assert.match(prompt, /Read current files as needed/);
  const patch = prompt.match(/<repository_diff>\n([\s\S]*?)\n<\/repository_diff>/)![1];
  assert.ok(patch.length <= 120_000); assert.match(patch, /-original\n\+start/);
  assert.doesNotMatch(patch, /\n\+end\n/);
});
