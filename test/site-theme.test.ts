import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/site-theme.js", import.meta.url), "utf8");
const storageKey = "peergrading-site-theme";
type Theme = "light" | "dark";

function openSite(options: {
  storage?: Map<string, string>;
  systemDark?: boolean;
  storageDenied?: "access" | "read" | "write";
  systemDenied?: boolean;
  legacySystemListener?: boolean;
  noMetadata?: boolean;
} = {}) {
  const storage = options.storage ?? new Map<string, string>();
  const writes: [string, string][] = [];
  const events: { type: string; detail?: unknown }[] = [];
  const listeners = new Map<string, ((event: any) => void)[]>();
  const systemListeners: ((event: { matches: boolean }) => void)[] = [];
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const metadata = new Map(["theme-color", "color-scheme"].map((name) => [name, {
    content: "",
    setAttribute(attribute: string, value: string) { assert.equal(attribute, "content"); this.content = value; },
  }]));
  const localStorage = {
    getItem(key: string) {
      if (options.storageDenied === "read") throw new Error("Storage read denied");
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.storageDenied === "write") throw new Error("Storage write denied");
      writes.push([key, value]); storage.set(key, value);
    },
  };
  const system: Record<string, any> = { matches: options.systemDark ?? false };
  if (options.legacySystemListener) system.addListener = (listener: (event: any) => void) => systemListeners.push(listener);
  else system.addEventListener = (name: string, listener: (event: any) => void) => {
    assert.equal(name, "change"); systemListeners.push(listener);
  };
  const page: Record<string, any> = {
    document: {
      documentElement: root,
      querySelector(selector: string) {
        if (options.noMetadata) return null;
        const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
        return name ? metadata.get(name) ?? null : null;
      },
    },
    localStorage,
    matchMedia(query: string) {
      assert.equal(query, "(prefers-color-scheme: dark)");
      if (options.systemDenied) throw new Error("System appearance unavailable");
      return system;
    },
    addEventListener(name: string, listener: (event: any) => void) {
      const callbacks = listeners.get(name) ?? []; callbacks.push(listener); listeners.set(name, callbacks);
    },
    dispatchEvent(event: { type: string; detail?: unknown }) {
      events.push(event); for (const listener of listeners.get(event.type) ?? []) listener(event); return true;
    },
    CustomEvent: class {
      type: string; detail: unknown;
      constructor(type: string, options: { detail?: unknown } = {}) { this.type = type; this.detail = options.detail; }
    },
  };
  if (options.storageDenied === "access") Object.defineProperty(page, "localStorage", {
    get() { throw new Error("Storage access denied"); },
  });
  page.window = page;
  vm.runInNewContext(source, page, { filename: "site-theme.js" });
  const theme = page.PeerGradingSiteTheme as {
    current(): Theme;
    apply(value: unknown, options?: { persist?: boolean }): Theme;
    toggle(): Theme;
  };
  return {
    theme, root, metadata, storage, writes, events,
    changeSystem(dark: boolean) {
      system.matches = dark; for (const listener of systemListeners) listener({ matches: dark });
    },
    storageChanged(key: string | null, value?: string) {
      if (key === null) storage.clear();
      else if (value === undefined) storage.delete(key);
      else storage.set(key, value);
      for (const listener of listeners.get("storage") ?? []) listener({ key, newValue: value ?? null, storageArea: localStorage });
    },
  };
}

function assertTheme(site: ReturnType<typeof openSite>, expected: Theme) {
  assert.equal(site.theme.current(), expected);
  assert.equal(site.root.dataset.theme, expected);
  assert.equal(site.root.style.colorScheme, expected);
  assert.equal(site.metadata.get("color-scheme")?.content, expected);
  assert.match(site.metadata.get("theme-color")?.content ?? "", /^#[a-f0-9]{6}$/i);
  assert.equal(site.events.at(-1)?.type, "site-theme-change");
  assert.equal(site.events.at(-1)?.detail, expected);
}

test("the public site's first appearance follows the system before controls initialize", () => {
  const day = openSite(), night = openSite({ systemDark: true });
  assertTheme(day, "light"); assertTheme(night, "dark");
  assert.notEqual(day.metadata.get("theme-color")?.content, night.metadata.get("theme-color")?.content);
  assert.deepEqual(day.writes, []); assert.deepEqual(night.writes, []);
});

test("public-site choice is remembered in both directions independently of desktop appearance", () => {
  const storage = new Map([["peergrading-theme", "dark"]]);
  const site = openSite({ storage });
  assertTheme(site, "light");
  site.theme.toggle(); assertTheme(site, "dark");
  assertTheme(openSite({ storage, systemDark: false }), "dark");
  site.theme.toggle(); assertTheme(site, "light");
  assertTheme(openSite({ storage, systemDark: true }), "light");
  assert.equal(storage.get("peergrading-theme"), "dark");
  assert.deepEqual(site.writes.map(([key]) => key), [storageKey, storageKey]);
});

test("invalid saved appearances and unsupported input cannot replace a valid theme", () => {
  for (const saved of ["", "system", "Dark", "null", "../preferences"]) {
    assertTheme(openSite({ storage: new Map([[storageKey, saved]]), systemDark: true }), "dark");
  }
  const site = openSite();
  site.theme.apply("dark");
  for (const value of [null, undefined, "system", "Dark", {}, ["light"], true]) {
    assert.equal(site.theme.apply(value), "dark"); assertTheme(site, "dark");
  }
  assert.deepEqual(site.writes, [[storageKey, "dark"]]);
});

test("denied storage and an unavailable system preference still allow day and night switching", () => {
  for (const storageDenied of ["access", "read", "write"] as const) {
    const site = openSite({ storageDenied, systemDark: true });
    assertTheme(site, "dark"); site.theme.toggle(); assertTheme(site, "light");
    // The selection remains authoritative for this page even if it cannot be persisted.
    site.changeSystem(true); assertTheme(site, "light");
    site.theme.toggle(); assertTheme(site, "dark");
  }
  const site = openSite({ storageDenied: "access", systemDenied: true });
  assertTheme(site, "light"); site.theme.toggle(); assertTheme(site, "dark");
  const withoutMetadata = openSite({ noMetadata: true });
  assert.equal(withoutMetadata.theme.toggle(), "dark");
  assert.equal(withoutMetadata.root.dataset.theme, "dark");
});

test("system appearance changes apply until a visitor explicitly chooses a theme", () => {
  for (const legacySystemListener of [false, true]) {
    const site = openSite({ legacySystemListener });
    site.changeSystem(true); assertTheme(site, "dark");
    site.changeSystem(false); assertTheme(site, "light");
    assert.deepEqual(site.writes, []);
    site.theme.apply("dark");
    site.changeSystem(false); assertTheme(site, "dark");
  }
});

test("other tabs can change or clear the public-site choice without causing another storage write", () => {
  const site = openSite();
  site.storageChanged("peergrading-theme", "dark"); assertTheme(site, "light");
  site.storageChanged(storageKey, "dark"); assertTheme(site, "dark");
  site.storageChanged(storageKey, "light"); assertTheme(site, "light");
  site.changeSystem(true); assertTheme(site, "light");
  site.storageChanged(storageKey, "invalid"); assertTheme(site, "dark");
  site.changeSystem(false); assertTheme(site, "light");
  site.storageChanged(storageKey, "dark"); assertTheme(site, "dark");
  site.storageChanged(null); assertTheme(site, "light");
  site.changeSystem(true); assertTheme(site, "dark");
  assert.deepEqual(site.writes, []);
});

test("a temporary preview does not overwrite the remembered public-site appearance", () => {
  const storage = new Map([[storageKey, "light"]]);
  const site = openSite({ storage });
  site.theme.apply("dark", { persist: false }); assertTheme(site, "dark");
  assertTheme(openSite({ storage, systemDark: true }), "light");
  assert.deepEqual(site.writes, []);
});
