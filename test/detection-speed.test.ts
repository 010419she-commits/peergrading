import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("agent detection does not run long model-generation probes", () => {
  const source = fs.readFileSync(new URL("../agents/detect.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Reply with the single word OK/);
  assert.doesNotMatch(source, /60_000|90_000/);
  assert.match(source, /识别阶段不发送模型请求/);
});
