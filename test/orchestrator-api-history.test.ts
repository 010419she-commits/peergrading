import { test } from "node:test";
import assert from "node:assert/strict";
import { runCollaboration, type RunConfig, type Event } from "../orchestrator.ts";
import type { Backend, Turn } from "../agents/types.ts";

test("each API Agent preserves its protocol history without exposing reasoning to the UI or the other Agent", async () => {
  const calls: Record<string, Turn[][]> = { A: [], B: [] };
  const events: Event[] = [];
  const makeBackend = (who: string, answers: string[]): Backend => ({ async chat(request) {
    calls[who].push(structuredClone(request.turns));
    const text = answers[calls[who].length - 1];
    request.onDelta(text);
    return { text, apiMessage: { role: "assistant", content: text, reasoning_content: `${who}-private-protocol-reasoning` } };
  } });
  const slot = (name: string) => ({ name, persona: "", agent: { id: name, title: name, model: "test-thinking-model", runner: { type: "openai", baseUrl: "https://unused.test/v1", apiKey: "fixture-key", model: "test-thinking-model" } } });
  const config = { task: "Write and review", lang: "en", cwd: process.cwd(), maxRounds: 2, discussionTurns: 0, agentA: slot("A"), agentB: slot("B") } as RunConfig;
  const result = await runCollaboration(config, (event) => events.push(event), new AbortController().signal, {
    A: makeBackend("A", ["<deliverable>Version one</deliverable>", "Reviewed.\nVERDICT: APPROVE"]),
    B: makeBackend("B", ["Revise this.\nVERDICT: REVISE", "<deliverable>Version two</deliverable>"]),
  });
  assert.equal(result.approved, true); assert.equal(result.finalVersion, 2);
  for (const who of ["A", "B"]) {
    assert.equal(calls[who].length, 2);
    const assistant = calls[who][1].find((turn) => turn.role === "assistant")!;
    assert.equal(assistant.apiMessage!.reasoning_content, `${who}-private-protocol-reasoning`);
    assert.equal(assistant.apiMessage!.content, assistant.text);
    const other = who === "A" ? "B" : "A";
    assert.doesNotMatch(JSON.stringify(calls[who]), new RegExp(`${other}-private-protocol-reasoning`));
  }
  assert.doesNotMatch(JSON.stringify({ events, result }), /private-protocol-reasoning|apiMessage|reasoning_content/);
});
