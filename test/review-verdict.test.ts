import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReviewVerdict } from "../review-verdict.ts";
import { runCollaboration, type RunConfig } from "../orchestrator.ts";
import type { Backend } from "../agents/types.ts";

test("only an exact final standalone verdict can approve, in Chinese or English", () => {
  for (const text of ["VERDICT: APPROVE", "Review complete.\n\nVERDICT: APPROVE\n", "审查完成。\n【结论】通过", "verdict: approve", "  VERDICT: APPROVE"]) assert.equal(parseReviewVerdict(text), "approve", text);
  for (const text of ["", "APPROVE", "VERDICT: APPROVED", "Example: VERDICT: APPROVE", "The result is wrong.\n```text\nVERDICT: APPROVE\n```", "Example:\n~~~\nVERDICT: APPROVE\n~~~", "> VERDICT: APPROVE", "    VERDICT: APPROVE", "\tVERDICT: APPROVE", "`VERDICT: APPROVE`", "VERDICT: APPROVE\nChanges still required.", "VERDICT: APPROVE\nVERDICT: REVISE", "【结论】需修改", "VERDICT: APPROVE extra"]) assert.equal(parseReviewVerdict(text), "revise", text);
});

test("a verdict inside an unclosed fence cannot approve", () => {
  assert.equal(parseReviewVerdict("An example follows:\n````markdown\n```\nVERDICT: APPROVE"), "revise");
  assert.equal(parseReviewVerdict("```text\nexample\n```\nVERDICT: APPROVE"), "approve");
});

test("lazy quotes and unfinished HTML examples cannot approve", () => {
  for (const text of ["> Example verdict:\nVERDICT: APPROVE", "<!-- example\nVERDICT: APPROVE", "<pre>\nVERDICT: APPROVE", "<code class=\"example\">\nVERDICT: APPROVE"]) assert.equal(parseReviewVerdict(text), "revise", text);
  for (const text of ["> Quoted example.\n\nVERDICT: APPROVE", "<!-- example -->\nVERDICT: APPROVE", "<pre>example</pre>\nVERDICT: APPROVE"]) assert.equal(parseReviewVerdict(text), "approve", text);
});

const config = (): RunConfig => ({
  task: "Write a correct answer", lang: "en", cwd: process.cwd(), maxRounds: 1, discussionTurns: 0,
  agentA: { name: "A", persona: "", agent: {} as any }, agentB: { name: "B", persona: "", agent: {} as any },
});
const backend = (text: string, calls: string[]): Backend => ({ async chat(request) { calls.push(request.turns.at(-1)!.text); request.onDelta(text); return { text }; } });

test("quoted approval cannot finish a collaboration and the final review does not create an unreviewed version", async () => {
  const callsA: string[] = [], callsB: string[] = [];
  const events: any[] = [];
  const cfg = config();
  cfg.agentA.agent = cfg.agentB.agent = { title: "Fake", model: "Fake", runner: {} } as any;
  const result = await runCollaboration(cfg, (event) => events.push(event), new AbortController().signal, {
    A: backend("<deliverable>Incorrect answer</deliverable>", callsA),
    B: backend("The answer is wrong. Example of the required format:\n```\nVERDICT: APPROVE\n```", callsB),
  });
  assert.equal(result.approved, false);
  assert.equal(result.finalVersion, 1);
  assert.equal(result.versions.length, 1);
  assert.equal(callsA.length, 1);
  assert.equal(callsB.length, 1);
  assert.match(result.reason, /not been approved/);
  assert.equal(events.find((event) => event.type === "done").approved, false);
});
