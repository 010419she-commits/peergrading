import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const { createThemePreferences, registerThemeIpc } = createRequire(import.meta.url)("../desktop/theme.cjs");

test("desktop theme persists across launches independently of the localhost origin", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peergrading-theme-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "data"));
  const credentials = path.join(directory, "data", "config.json");
  fs.writeFileSync(credentials, "existing private settings");

  const firstLaunch = createThemePreferences(directory, () => false);
  assert.equal(firstLaunch.getTheme(), "light");
  assert.equal(firstLaunch.setTheme("dark"), "dark");
  assert.equal(createThemePreferences(directory, () => false).getTheme(), "dark");
  assert.equal(fs.readFileSync(credentials, "utf8"), "existing private settings");
  assert.deepEqual(fs.readdirSync(directory).sort(), ["data", "ui-preferences.json"]);
  firstLaunch.setTheme("light");
  assert.equal(createThemePreferences(directory, () => true).getTheme(), "light");
});

test("missing, malformed and invalid preferences fall back to the system theme", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peergrading-theme-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preferencesFile = path.join(directory, "ui-preferences.json");
  for (const contents of [undefined, "{broken", "null", '{"theme":"system"}', '{"theme":{}}']) {
    if (contents !== undefined) fs.writeFileSync(preferencesFile, contents);
    assert.equal(createThemePreferences(directory, () => true).getTheme(), "dark");
    assert.equal(createThemePreferences(directory, () => false).getTheme(), "light");
  }
});

test("unsupported theme values cannot change preferences or create arbitrary files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peergrading-theme-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preferences = createThemePreferences(directory, () => false);
  preferences.setTheme("dark");
  const before = fs.readFileSync(path.join(directory, "ui-preferences.json"), "utf8");
  for (const value of [null, undefined, "system", "../other", "Light", {}, ["light"], true]) {
    assert.throws(() => preferences.setTheme(value), /Theme must be light or dark/);
    assert.equal(preferences.getTheme(), "dark");
    assert.equal(fs.readFileSync(path.join(directory, "ui-preferences.json"), "utf8"), before);
  }
  assert.deepEqual(fs.readdirSync(directory), ["ui-preferences.json"]);
});

test("theme IPC checks window trust before exposing or changing preferences", () => {
  const handlers = new Map();
  let reads = 0, writes = 0, colorUpdates = 0;
  const ipc = {
    removeAllListeners: (name) => handlers.delete(name),
    removeHandler: (name) => handlers.delete(name),
    on: (name, handler) => handlers.set(name, handler),
    handle: (name, handler) => handlers.set(name, handler),
  };
  const trusted = (event) => { if (!event.trusted) throw new Error("Invalid window"); };
  registerThemeIpc(ipc, trusted, {
    getTheme: () => { reads++; return "dark"; },
    setTheme: (theme) => { writes++; return theme; },
  }, () => { colorUpdates++; });

  const untrusted = { trusted: false, returnValue: undefined };
  handlers.get("peergrading:initial-theme")(untrusted);
  assert.equal(untrusted.returnValue, null);
  assert.throws(() => handlers.get("peergrading:get-theme")(untrusted), /Invalid window/);
  assert.throws(() => handlers.get("peergrading:set-theme")(untrusted, "light"), /Invalid window/);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(colorUpdates, 0);

  const valid = { trusted: true, returnValue: undefined };
  handlers.get("peergrading:initial-theme")(valid);
  assert.equal(valid.returnValue, "dark");
  assert.equal(handlers.get("peergrading:get-theme")(valid), "dark");
  assert.equal(handlers.get("peergrading:set-theme")(valid, "light"), "light");
  assert.equal(reads, 2);
  assert.equal(writes, 1);
  assert.equal(colorUpdates, 1);
});
