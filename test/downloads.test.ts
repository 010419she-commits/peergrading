import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSiteApp } from "../site-server.ts";

const release = (version: string) => ({
  version,
  repo: "010419she-commits/peergrading",
  assets: [
    { name: `PeerGrading-${version}-mac-arm64.zip`, url: `https://github.com/010419she-commits/peergrading/releases/download/v${version}/PeerGrading-${version}-mac-arm64.zip`, platform: "macos", arch: "arm64", size: 101 },
    { name: `PeerGrading-${version}.dmg`, url: `https://github.com/010419she-commits/peergrading/releases/download/v${version}/PeerGrading-${version}.dmg`, platform: "macos", arch: "x64", size: 102 },
    { name: `PeerGrading Setup ${version}.exe`, url: `https://github.com/010419she-commits/peergrading/releases/download/v${version}/PeerGrading%20Setup%20${version}.exe`, platform: "windows", arch: "x64", size: 103 },
  ],
});

test("public site serves only presentation files and the GitHub Release manifest", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pg-downloads-"));
  const manifest = release("0.6.0");
  fs.writeFileSync(path.join(temporary, "index.html"), "<!doctype html><title>PeerGrading downloads</title>");
  fs.writeFileSync(path.join(temporary, "privacy.html"), "privacy");
  fs.writeFileSync(path.join(temporary, "terms.html"), "terms");
  fs.writeFileSync(path.join(temporary, "site.css"), "body{}");
  fs.writeFileSync(path.join(temporary, "installers.json"), JSON.stringify(manifest));
  fs.mkdirSync(path.join(temporary, "downloads"));
  fs.writeFileSync(path.join(temporary, "downloads", "PeerGrading Setup 9.9.9.exe"), "not a release source");
  fs.writeFileSync(path.join(temporary, "site.js"), "legacy account code");
  const app = createSiteApp(temporary);
  const server = await new Promise<any>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  const home = await fetch(base + "/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /PeerGrading downloads/);
  for (const route of ["/privacy", "/terms", "/site.css"]) assert.equal((await fetch(base + route)).status, 200, route);
  const response = await fetch(base + "/installers.json");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), manifest);
  assert.ok(manifest.assets.every((asset) => asset.url.startsWith("https://github.com/010419she-commits/peergrading/releases/download/")));

  for (const route of ["/api/download/latest", "/api/auth/bootstrap", "/api/sessions", "/api/billing/orders", "/app", "/login", "/account", "/admin", "/pair", "/download/PeerGrading%20Setup%209.9.9.exe", "/site.js", "/payment-sdk.js"]) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  assert.equal((await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
  assert.equal(fs.existsSync(path.join(temporary, "data", "app.db")), false);

  const updated = release("0.6.1");
  const target = path.join(temporary, "installers.json");
  fs.writeFileSync(target, JSON.stringify(updated));
  const old = new Date(Date.UTC(2020, 0, 1));
  fs.utimesSync(target, old, old);
  assert.deepEqual(await (await fetch(base + "/installers.json")).json(), updated, "manifest content, not mtime or local installer files, determines downloads");
});
