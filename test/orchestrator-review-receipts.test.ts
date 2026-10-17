import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runCollaboration, type RunConfig, type Event } from "../orchestrator.ts";
import type { Backend, ChatRequest } from "../agents/types.ts";
import type { RepositoryManifest, RepositoryReview } from "../repository/workspace.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pg-review-receipts-"));
after(async () => {
  const target = path.resolve(temporary);
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(target, { recursive: true, force: true });
});
function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const agent = (name: string) => ({ name, persona: "", agent: { id: name, kind: "cli", title: name, subtitle: "", model: "fake", local: true, status: "ready", auto: true, runner: { type: "codex", bin: "unused" }, icon: "" } as any });
const backend = (action: (request: ChatRequest) => string | Promise<string>): Backend => ({
  async chat(request) { const text = await action(request); request.onDelta(text); return { text }; },
});
async function fixture(name: string, script: string): Promise<RunConfig> {
  const repo = path.join(temporary, name); await fs.mkdir(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "Test"]); git(repo, ["config", "user.email", "test@example.invalid"]);
  await fs.writeFile(path.join(repo, "app.txt"), "original\n"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "baseline"]);
  return { task: "Fix app.txt", lang: "en", agentA: agent("A"), agentB: agent("B"), maxRounds: 2, discussionTurns: 0, cwd: repo,
    repository: { path: repo, sessionDir: path.join(temporary, `${name}-session`), checks: [{ argv: [process.execPath, "-e", script] }] } };
}
async function assertStoredReviews(manifest: RepositoryManifest, events: Event[]) {
  const stored = JSON.parse(await fs.readFile(path.join(path.dirname(manifest.worktreePath), "manifest.json"), "utf8"));
  assert.deepEqual(stored.reviews, manifest.reviews);
  assert.deepEqual(events.filter((event) => event.type === "repository_review").map((event) => event.review), manifest.reviews);
  assert.equal(new Set(manifest.reviews!.map((review) => review.id)).size, manifest.reviews!.length);
  for (const review of manifest.reviews!) {
    const snapshot = manifest.snapshots.find((item) => item.n === review.version)!;
    assert.equal(review.commit, snapshot.commit); assert.ok(Number.isFinite(Date.parse(review.createdAt)));
    assert.deepEqual(review.checkIds, snapshot.checks.map((check) => check.id));
  }
}

test("real author rotation stores reviews for the correct version, commit and executed checks", async () => {
  const cfg = await fixture("alternating", "if(require('fs').readFileSync('app.txt','utf8').trim()!=='fixed')process.exit(1)");
  const original = git(cfg.cwd, ["rev-parse", "HEAD"]);
  const A = backend(async (request) => {
    if (request.repositoryAccess === "write") { await fs.writeFile(path.join(request.cwd, "app.txt"), "first attempt\n"); return "Initial attempt"; }
    return "The corrected files and validation match.\nVERDICT: APPROVE";
  });
  const B = backend(async (request) => {
    if (request.repositoryAccess === "write") { await fs.writeFile(path.join(request.cwd, "app.txt"), "fixed\n"); return "Fixed the failing check"; }
    return "VERDICT: APPROVE";
  });
  const events: Event[] = [];
  const result = await runCollaboration(cfg, (event) => events.push(structuredClone(event)), new AbortController().signal, { A, B });
  const manifest = result.repository!;
  assert.equal(result.approved, true); assert.equal(result.finalVersion, 2); assert.equal(manifest.status, "approved");
  assert.deepEqual(manifest.reviews!.map((review) => [review.round, review.version, review.reviewer, review.kind, review.verdict]), [
    [1, 1, "B", "review", "revise"], [2, 2, "A", "review", "approve"],
  ]);
  assert.notEqual(manifest.reviews![0].commit, manifest.reviews![1].commit);
  assert.notDeepEqual(manifest.reviews![0].checkIds, manifest.reviews![1].checkIds);
  assert.equal(manifest.reviews!.at(-1)!.commit, manifest.finalCommit);
  assert.deepEqual(events.filter((event) => event.type === "message_end" && event.verdict).map((event) => event.verdict), ["revise", "approve"]);
  await assertStoredReviews(manifest, events);
  assert.equal(git(cfg.cwd, ["rev-parse", "HEAD"]), original); assert.equal(git(cfg.cwd, ["status", "--porcelain"]), "");
});

test("failing execution forces both review and counter receipts to revise despite agent approval", async () => {
  const cfg = await fixture("failed-counter", "console.error('required check failed');process.exit(5)");
  cfg.maxRounds = 1; cfg.discussionTurns = 2;
  let writes = 0;
  const A = backend(async (request) => {
    if (request.repositoryAccess === "write") { writes++; await fs.writeFile(path.join(request.cwd, "app.txt"), "candidate\n"); return "Candidate"; }
    return "The failed validation still needs a correction.";
  });
  const B = backend(() => "VERDICT: APPROVE");
  const events: Event[] = [];
  const result = await runCollaboration(cfg, (event) => events.push(structuredClone(event)), new AbortController().signal, { A, B });
  const manifest = result.repository!;
  assert.equal(result.approved, false); assert.equal(result.finalVersion, 1); assert.equal(writes, 1);
  assert.equal(manifest.status, "max_rounds"); assert.equal(manifest.snapshots[0].checks[0].code, 5);
  assert.deepEqual(manifest.reviews!.map((review) => [review.kind, review.verdict]), [["review", "revise"], ["counter", "revise"]]);
  assert.ok(manifest.reviews!.every((review) => review.round === 1 && review.version === 1 && review.reviewer === "B"));
  assert.equal(manifest.reviews![0].commit, manifest.reviews![1].commit);
  assert.deepEqual(manifest.reviews![0].checkIds, manifest.reviews![1].checkIds);
  assert.deepEqual(events.filter((event) => event.type === "message_end" && event.verdict).map((event) => event.verdict), ["revise", "revise"]);
  await assertStoredReviews(manifest, events);
});

test("a valid counter approval records fresh sign-off against the unchanged reviewed checkpoint", async () => {
  const cfg = await fixture("counter-approved", "console.log('validation passed')");
  cfg.maxRounds = 1; cfg.discussionTurns = 2;
  const A = backend(async (request) => {
    if (request.repositoryAccess === "write") { await fs.writeFile(path.join(request.cwd, "app.txt"), "fixed\n"); return "Fixed app.txt"; }
    return "The implementation and recorded validation address that concern.";
  });
  let responses = 0;
  const B = backend(() => ++responses === 1
    ? "This is an example marker, not my sign-off:\n```text\nVERDICT: APPROVE\n```"
    : "The explanation resolves my concern.\nVERDICT: APPROVE");
  const events: Event[] = [];
  const result = await runCollaboration(cfg, (event) => events.push(structuredClone(event)), new AbortController().signal, { A, B });
  const manifest = result.repository!;
  assert.equal(result.approved, true); assert.equal(result.finalVersion, 1); assert.equal(manifest.snapshots.length, 1);
  assert.deepEqual(manifest.reviews!.map((review: RepositoryReview) => [review.kind, review.verdict]), [["review", "revise"], ["counter", "approve"]]);
  assert.equal(manifest.reviews!.at(-1)!.commit, manifest.finalCommit);
  assert.deepEqual(manifest.reviews![0].checkIds, manifest.reviews![1].checkIds);
  await assertStoredReviews(manifest, events);
});
