import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { prepareSigning, cleanupSigning } from "../scripts/macos-signing.mjs";

test("the installed builder requires CSC_LINK to be absent, not an empty value", () => {
  const require = createRequire(import.meta.url);
  // Load the package entry first to initialize its circular module graph.
  require("app-builder-lib");
  const { PlatformPackager } = require("app-builder-lib/out/platformPackager.js");
  const pkg = require("../package.json");
  const resolveLink = () => PlatformPackager.prototype.getCscLink.call({ info: { config: pkg.build }, platformSpecificBuildOptions: pkg.build.mac });
  const original = process.env.CSC_LINK;
  try {
    process.env.CSC_LINK = "";
    assert.equal(resolveLink(), "");
    delete process.env.CSC_LINK;
    assert.equal(resolveLink() == null, true);
  } finally {
    if (original === undefined) delete process.env.CSC_LINK;
    else process.env.CSC_LINK = original;
  }
});

function fixture(t: any, failure = "", identity = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pg-signing-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const runnerTemp = path.join(cwd, "runner-temp");
  fs.mkdirSync(runnerTemp);
  const roots = path.join(cwd, "node_modules/app-builder-lib/certs/root_certs.keychain");
  fs.mkdirSync(path.dirname(roots), { recursive: true });
  fs.writeFileSync(roots, "test certificate roots");
  const original = [path.join(cwd, "existing login.keychain-db"), path.join(cwd, "system.keychain")];
  let current = [...original];
  const calls: string[][] = [];
  const writes: string[] = [];
  const certificate = Buffer.from("test PKCS12 content");
  const env = { RUNNER_TEMP: runnerTemp, CSC_LINK: certificate.toString("base64"), CSC_KEY_PASSWORD: "test-p12-password" };
  const spawnSync = (binary: string, args: string[], options: any) => {
    assert.equal(binary, "/usr/bin/security");
    assert.equal(options.shell, undefined);
    calls.push([...args]);
    if (args[0] === "import") assert.deepEqual(fs.readFileSync(args[1]), certificate);
    if (args[0] === failure) return { status: 1, stdout: "", stderr: `private failure ${env.CSC_KEY_PASSWORD}` };
    if (args[0] === "list-keychains") {
      if (args.includes("-s")) current = args.slice(args.indexOf("-s") + 1);
      return { status: 0, stdout: current.map(file => `    "${file}"`).join("\n") };
    }
    if (args[0] === "find-identity") return { status: 0, stdout: identity
      ? `  1) ${"F".repeat(40)} "Developer ID Application: Test Fixture"\n     1 valid identities found\n`
      : "     0 valid identities found\n" };
    return { status: 0, stdout: "" };
  };
  const options = { env, spawnSync, cwd, writeEnv: (text: string) => writes.push(text) };
  return { cwd, runnerTemp, roots, original, calls, writes, env, options, current: () => current };
}

test("signing uses separate keychain and certificate passwords, preserves trust roots and cleans temporary data", t => {
  const f = fixture(t);
  const result = prepareSigning(f.options);
  assert.equal(result.skipped, false);
  const create = f.calls.find(args => args[0] === "create-keychain")!;
  const unlock = f.calls.find(args => args[0] === "unlock-keychain")!;
  const imported = f.calls.find(args => args[0] === "import")!;
  const partition = f.calls.find(args => args[0] === "set-key-partition-list")!;
  const keychainPassword = create[2];
  assert.notEqual(keychainPassword, f.env.CSC_KEY_PASSWORD);
  assert.equal(unlock[2], keychainPassword);
  assert.equal(partition[partition.indexOf("-k") + 1], keychainPassword);
  assert.equal(imported[imported.indexOf("-P") + 1], f.env.CSC_KEY_PASSWORD);
  assert.deepEqual(imported.slice(imported.indexOf("-f"), -2), ["-f", "pkcs12", "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild"]);
  assert.deepEqual(f.current(), [result.keychainFile, f.roots, ...f.original]);
  assert.equal(f.writes.join(""), `CSC_KEYCHAIN=${result.keychainFile}\nCSC_LINK=\n`);
  assert.ok(!f.writes.join("").includes(keychainPassword));
  assert.ok(!f.writes.join("").includes(f.env.CSC_KEY_PASSWORD));
  assert.equal(fs.existsSync(imported[1]), false);
  assert.deepEqual(fs.readdirSync(path.dirname(result.keychainFile!)), []);
  cleanupSigning({ env: { ...f.env, CSC_KEYCHAIN: result.keychainFile! }, spawnSync: f.options.spawnSync });
  assert.equal(fs.existsSync(path.dirname(result.keychainFile!)), false);
  assert.deepEqual(f.current(), [f.roots, ...f.original]);
  assert.equal(f.calls.at(-1)![0], "delete-keychain");
});

for (const stage of ["create-keychain", "import", "set-key-partition-list", "find-identity"]) {
  test(`signing failure in ${stage} leaves no exported environment or certificate and hides child output`, t => {
    const f = fixture(t, stage);
    assert.throws(() => prepareSigning(f.options), { message: `macOS signing: security ${stage} failed.` });
    assert.deepEqual(f.writes, []);
    assert.deepEqual(fs.readdirSync(f.runnerTemp), []);
    assert.deepEqual(f.current(), f.original);
    assert.ok(f.calls.some(args => args[0] === "delete-keychain"));
  });
}

test("an imported certificate without a valid Developer ID identity fails before environment export", t => {
  const f = fixture(t, "", false);
  assert.throws(() => prepareSigning(f.options), /no valid Developer ID Application identity/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.current(), f.original);
  assert.deepEqual(fs.readdirSync(f.runnerTemp), []);
});

test("absent signing credentials skip without invoking security or requiring GITHUB_ENV", () => {
  const spawnSync = () => { throw new Error("should not run security"); };
  assert.deepEqual(prepareSigning({ env: {}, spawnSync }), { skipped: true });
  assert.deepEqual(cleanupSigning({ env: {}, spawnSync }), { skipped: true });
});

test("non-base64 certificate sources fail without invoking security or exposing their value", () => {
  const spawnSync = () => { throw new Error("should not run security"); };
  for (const CSC_LINK of ["https://example.invalid/certificate.p12", "./certificate.p12", "@@invalid@@"]) {
    assert.throws(() => prepareSigning({ env: { CSC_LINK }, spawnSync }), {
      message: "macOS signing: CSC_LINK must contain a base64 PKCS#12 file.",
    });
  }
});

test("cleanup rejects a keychain outside its generated temporary directory", t => {
  const f = fixture(t);
  assert.throws(() => cleanupSigning({ env: { ...f.env, CSC_KEYCHAIN: path.join(f.cwd, "login.keychain-db") }, spawnSync: f.options.spawnSync }), /unmanaged keychain/);
  assert.deepEqual(f.calls, []);
});
