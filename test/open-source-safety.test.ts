import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText, sensitivePath } from "../scripts/check-open-source.mjs";

test("open-source scanner blocks private paths without reading their contents", () => {
  assert.equal(sensitivePath(".env"), "environment-file");
  assert.equal(sensitivePath("data/app.db"), "private-or-generated-directory");
  assert.equal(sensitivePath("deploy/keys/github-actions"), "key-directory");
  assert.equal(sensitivePath("config/service.pem"), "key-or-database-file");
  assert.equal(sensitivePath(".env.example"), null);
  assert.equal(sensitivePath("src/config.ts"), null);
});

test("open-source scanner detects representative credentials assembled at runtime", () => {
  const key = ["sk", "abcdefghijklmnopqrstuvwxyz"].join("-");
  const privateKey = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const github = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  assert.deepEqual(scanText(`value=${key}`), ["openai-compatible-key"]);
  assert.deepEqual(scanText(privateKey), ["private-key-block"]);
  assert.deepEqual(scanText(github), ["github-token"]);
  assert.deepEqual(scanText(["C:", "Users", "Example"].join("\\")), ["personal-local-path"]);
});

test("open-source scanner rejects high-entropy assignments but ignores explicit fixtures", () => {
  const randomValue = ["a", "B", "3", "x", "Q", "9", "z", "K", "2", "m", "P", "7", "v", "D", "4", "s", "J", "8"].join("");
  assert.deepEqual(scanText(`apiKey: "${randomValue}"`), ["high-entropy-credential-assignment"]);
  assert.deepEqual(scanText("apiKey: \"fixture-not-a-secret\""), []);
  assert.deepEqual(scanText("const answer = 42;"), []);
});
