import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = () => fs.readFileSync(new URL("../public/theme.js", import.meta.url), "utf8");

type Theme = "light" | "dark";
type ThemeApi = {
  current(): Theme;
  toggle(): Theme;
  apply(theme: Theme, options?: { persist?: boolean }): unknown;
};

function openPage(options: {
  preferences?: Map<string, string>;
  systemDark?: boolean;
  storageDenied?: boolean | "access";
  systemDenied?: boolean;
  desktopTheme?: string;
} = {}) {
  const preferences = options.preferences ?? new Map<string, string>();
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const colorScheme = { content: "" };
  const desktopWrites: Theme[] = [];
  const storage = {
    getItem(key: string) {
      if (options.storageDenied) throw new Error("Storage is unavailable");
      return preferences.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.storageDenied) throw new Error("Storage is unavailable");
      preferences.set(key, value);
    },
  };
  const page: Record<string, any> = {
    document: {
      documentElement: root,
      querySelector: (selector: string) => /meta.*color-scheme/.test(selector) ? colorScheme : null,
    },
    localStorage: storage,
    matchMedia: () => {
      if (options.systemDenied) throw new Error("System preference is unavailable");
      return { matches: options.systemDark ?? false };
    },
  };
  if (options.storageDenied === "access") Object.defineProperty(page, "localStorage", {
    get() { throw new Error("Storage access is unavailable"); },
  });
  if (Object.hasOwn(options, "desktopTheme")) page.peergrading = {
    theme: options.desktopTheme,
    setTheme(value: Theme) { desktopWrites.push(value); return Promise.resolve(); },
  };
  page.window = page;
  vm.runInNewContext(source(), page, { filename: "theme.js" });
  return { theme: page.PeerGradingTheme as ThemeApi, root, colorScheme, preferences, desktopWrites };
}

function assertTheme(page: ReturnType<typeof openPage>, expected: Theme) {
  assert.equal(page.theme.current(), expected);
  assert.equal(page.root.dataset.theme, expected);
  assert.equal(page.root.style.colorScheme, expected);
  assert.equal(page.colorScheme.content, expected);
}

test("a new page follows the system day or night preference", () => {
  assertTheme(openPage({ systemDark: false }), "light");
  assertTheme(openPage({ systemDark: true }), "dark");
});

test("an explicit remembered theme overrides the system preference", () => {
  assertTheme(openPage({ preferences: new Map([["peergrading-theme", "light"]]), systemDark: true }), "light");
  assertTheme(openPage({ preferences: new Map([["peergrading-theme", "dark"]]), systemDark: false }), "dark");
  assertTheme(openPage({ preferences: new Map([["peergrading-theme", "invalid"]]), systemDark: true }), "dark");
});

test("the desktop preference takes priority across page origins and toggles save through the bridge", () => {
  const page = openPage({ desktopTheme: "dark", preferences: new Map([["peergrading-theme", "light"]]), systemDark: false });
  assertTheme(page, "dark");
  assert.deepEqual(page.desktopWrites, [], "Opening a page must not overwrite the desktop preference");
  assert.equal(page.theme.toggle(), "light");
  assertTheme(page, "light");
  assert.deepEqual(page.desktopWrites, ["light"]);
  // A new localhost port has fresh web storage; the desktop bridge restores the choice.
  const nextOrigin = openPage({ desktopTheme: page.desktopWrites.at(-1), systemDark: true });
  assertTheme(nextOrigin, "light");
  assert.equal(nextOrigin.theme.toggle(), "dark");
  assertTheme(nextOrigin, "dark");
  assert.deepEqual(nextOrigin.desktopWrites, ["dark"]);
  assertTheme(openPage({ desktopTheme: "invalid", preferences: new Map([["peergrading-theme", "light"]]), systemDark: true }), "light");
});

test("one click toggles the theme and the next page remembers it in both directions", () => {
  const preferences = new Map<string, string>();
  let page = openPage({ preferences, systemDark: false });
  assert.equal(page.theme.toggle(), "dark");
  assertTheme(page, "dark");
  assert.equal(preferences.get("peergrading-theme"), "dark");
  page = openPage({ preferences, systemDark: false });
  assertTheme(page, "dark");
  assert.equal(page.theme.toggle(), "light");
  assertTheme(page, "light");
  assert.equal(preferences.get("peergrading-theme"), "light");
  assertTheme(openPage({ preferences, systemDark: true }), "light");
});

test("a temporary theme application does not replace the remembered choice", () => {
  const preferences = new Map([["peergrading-theme", "light"]]);
  const page = openPage({ preferences });
  page.theme.apply("dark", { persist: false });
  assertTheme(page, "dark");
  assert.equal(preferences.get("peergrading-theme"), "light");
  assertTheme(openPage({ preferences }), "light");
});

test("an explicit theme application is remembered by default", () => {
  const preferences = new Map<string, string>();
  const page = openPage({ preferences });
  page.theme.apply("dark");
  assertTheme(page, "dark");
  assert.equal(preferences.get("peergrading-theme"), "dark");
  assertTheme(openPage({ preferences, systemDark: false }), "dark");
});

test("unavailable storage still allows an OS default and both toggle directions", () => {
  for (const storageDenied of [true, "access"] as const) {
    const page = openPage({ storageDenied, systemDark: true });
    assertTheme(page, "dark");
    assert.equal(page.theme.toggle(), "light");
    assertTheme(page, "light");
    assert.equal(page.theme.toggle(), "dark");
    assertTheme(page, "dark");
  }
});

test("a failed system query and denied storage fall back to day mode", () => {
  assertTheme(openPage({ storageDenied: true, systemDenied: true }), "light");
});
