// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  createThemeController,
  parseThemePreference,
  THEME_STORAGE_KEY,
  type ThemeMedia,
  type ThemeStorage,
} from "../apps/browser-extension/src/theme";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function system(dark = false) {
  const listeners = new Set<() => void>();
  const media: ThemeMedia = {
    get matches() {
      return dark;
    },
    addEventListener: vi.fn((_type, listener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type, listener) => {
      listeners.delete(listener);
    }),
  };
  return {
    media,
    change(value: boolean) {
      dark = value;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function fixture(saved?: unknown, dark = false) {
  const root = document.createElement("div");
  const appearance = system(dark);
  const storage: ThemeStorage = {
    get: vi.fn(async () => ({ [THEME_STORAGE_KEY]: saved })),
    set: vi.fn(async () => {}),
  };
  const onChange = vi.fn();
  const controller = createThemeController({
    root,
    media: appearance.media,
    storage,
    onChange,
  });
  return { root, appearance, storage, onChange, controller };
}

it.each([undefined, null, "unknown", 0, {}, "__proto__", "system"])(
  "falls back to system for an absent or unsupported preference (%s)",
  (value) => {
    expect(parseThemePreference(value)).toBe("system");
  },
);

it.each(["light", "dark"] as const)(
  "accepts the explicit %s preference",
  (value) => {
    expect(parseThemePreference(value)).toBe(value);
  },
);

it("applies the system appearance synchronously before storage finishes", async () => {
  const reading = deferred<Record<string, unknown>>();
  const root = document.createElement("div");
  const storage = {
    get: vi.fn(() => reading.promise),
    set: vi.fn(async () => {}),
  };
  const controller = createThemeController({
    root,
    storage,
    media: system(true).media,
  });
  expect(root.dataset.theme).toBe("dark");
  expect(root.dataset.themePreference).toBe("system");
  expect(root.style.colorScheme).toBe("dark");
  reading.resolve({ [THEME_STORAGE_KEY]: "light" });
  await controller.ready;
  expect(root.dataset.theme).toBe("light");
  expect(root.dataset.themePreference).toBe("light");
  controller.destroy();
});

it("follows operating system changes only while system is selected", async () => {
  const f = fixture("system");
  await f.controller.ready;
  f.appearance.change(true);
  expect(f.root.dataset.theme).toBe("dark");
  await f.controller.setPreference("light");
  const changes = f.onChange.mock.calls.length;
  f.appearance.change(false);
  f.appearance.change(true);
  expect(f.root.dataset.theme).toBe("light");
  expect(f.onChange).toHaveBeenCalledTimes(changes);
  await f.controller.setPreference("system");
  expect(f.root.dataset.theme).toBe("dark");
  f.appearance.change(false);
  expect(f.root.dataset.theme).toBe("light");
  f.controller.destroy();
});

it("stores only its own preference key and restores that explicit choice", async () => {
  const f = fixture("dark");
  await f.controller.ready;
  expect(f.storage.get).toHaveBeenCalledExactlyOnceWith(THEME_STORAGE_KEY);
  expect(f.root.dataset.theme).toBe("dark");
  expect(await f.controller.setPreference("light")).toBe(true);
  expect(f.storage.set).toHaveBeenCalledExactlyOnceWith({
    [THEME_STORAGE_KEY]: "light",
  });
  expect(f.controller.getSnapshot().persistence).toBe("saved");
  f.controller.destroy();
});

it("ignores malformed saved data without overwriting any storage", async () => {
  const f = fixture({ theme: "dark", credential: "synthetic-secret" }, true);
  await f.controller.ready;
  expect(f.controller.getSnapshot().preference).toBe("system");
  expect(f.root.dataset.theme).toBe("dark");
  expect(f.storage.set).not.toHaveBeenCalled();
  expect(JSON.stringify(f.onChange.mock.calls)).not.toContain(
    "synthetic-secret",
  );
  f.controller.destroy();
});

it("keeps system usable and reports unavailable persistence after a read failure", async () => {
  const f = fixture(undefined, true);
  vi.mocked(f.storage.get).mockRejectedValueOnce(
    Error("synthetic-private-error"),
  );
  await expect(f.controller.ready).resolves.toBeUndefined();
  expect(f.controller.getSnapshot()).toEqual({
    preference: "system",
    resolved: "dark",
    persistence: "unavailable",
  });
  f.appearance.change(false);
  expect(f.root.dataset.theme).toBe("light");
  expect(JSON.stringify(f.onChange.mock.calls)).not.toContain(
    "synthetic-private-error",
  );
  f.controller.destroy();
});

it("retains the tab's selected theme after write failure without claiming it was saved", async () => {
  const f = fixture("light");
  await f.controller.ready;
  vi.mocked(f.storage.set).mockRejectedValueOnce(
    Error("synthetic-private-error"),
  );
  expect(await f.controller.setPreference("dark")).toBe(false);
  expect(f.controller.getSnapshot()).toEqual({
    preference: "dark",
    resolved: "dark",
    persistence: "unavailable",
  });
  expect(f.root.dataset.theme).toBe("dark");
  expect(JSON.stringify(f.onChange.mock.calls)).not.toContain(
    "synthetic-private-error",
  );
  expect(await f.controller.setPreference("light")).toBe(true);
  expect(f.controller.getSnapshot().persistence).toBe("saved");
  f.controller.destroy();
});

it("does not let a delayed stored choice replace a newer user selection", async () => {
  const reading = deferred<Record<string, unknown>>();
  const storage = {
    get: vi.fn(() => reading.promise),
    set: vi.fn(async () => {}),
  };
  const root = document.createElement("div");
  const controller = createThemeController({
    root,
    storage,
    media: system().media,
  });
  await controller.setPreference("dark");
  reading.resolve({ [THEME_STORAGE_KEY]: "light" });
  await controller.ready;
  expect(controller.getSnapshot()).toEqual({
    preference: "dark",
    resolved: "dark",
    persistence: "saved",
  });
  expect(root.dataset.theme).toBe("dark");
  controller.destroy();
});

it("serializes fast choices so an older write cannot finish after the latest write", async () => {
  const f = fixture("system");
  await f.controller.ready;
  const writing = deferred<void>();
  vi.mocked(f.storage.set).mockReturnValueOnce(writing.promise);
  const first = f.controller.setPreference("dark");
  const last = f.controller.setPreference("light");
  await Promise.resolve();
  expect(f.storage.set).toHaveBeenCalledTimes(1);
  expect(f.root.dataset.theme).toBe("light");
  expect(f.controller.getSnapshot().persistence).toBe("pending");
  writing.resolve();
  await Promise.all([first, last]);
  expect(vi.mocked(f.storage.set).mock.calls).toEqual([
    [{ [THEME_STORAGE_KEY]: "dark" }],
    [{ [THEME_STORAGE_KEY]: "light" }],
  ]);
  expect(f.controller.getSnapshot()).toEqual({
    preference: "light",
    resolved: "light",
    persistence: "saved",
  });
  f.controller.destroy();
});

it("removes its listener and does not apply late reads or selections after destruction", async () => {
  const reading = deferred<Record<string, unknown>>();
  const appearance = system();
  const root = document.createElement("div");
  const onChange = vi.fn();
  const storage = {
    get: vi.fn(() => reading.promise),
    set: vi.fn(async () => {}),
  };
  const controller = createThemeController({
    root,
    storage,
    media: appearance.media,
    onChange,
  });
  expect(appearance.listenerCount()).toBe(1);
  controller.destroy();
  controller.destroy();
  expect(appearance.listenerCount()).toBe(0);
  expect(appearance.media.removeEventListener).toHaveBeenCalledTimes(1);
  appearance.change(true);
  reading.resolve({ [THEME_STORAGE_KEY]: "dark" });
  await controller.ready;
  expect(await controller.setPreference("dark")).toBe(false);
  expect(root.dataset.theme).toBe("light");
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(storage.set).not.toHaveBeenCalled();
});

it("uses browser local storage and the standard media query by default", async () => {
  const appearance = system(true);
  const storage = {
    get: vi.fn(async () => ({ [THEME_STORAGE_KEY]: "system" })),
    set: vi.fn(async () => {}),
  };
  vi.stubGlobal("chrome", { storage: { local: storage } });
  const matchMedia = vi.fn(() => appearance.media);
  vi.stubGlobal("matchMedia", matchMedia);
  const root = document.createElement("div");
  const controller = createThemeController({ root });
  await controller.ready;
  expect(matchMedia).toHaveBeenCalledExactlyOnceWith(
    "(prefers-color-scheme: dark)",
  );
  expect(root.dataset.theme).toBe("dark");
  expect(await controller.setPreference("light")).toBe(true);
  expect(storage.set).toHaveBeenCalledExactlyOnceWith({
    [THEME_STORAGE_KEY]: "light",
  });
  controller.destroy();
});

it("falls back to light system appearance when media and storage APIs are unavailable", async () => {
  vi.stubGlobal("chrome", undefined);
  vi.stubGlobal("matchMedia", undefined);
  const root = document.createElement("div");
  const controller = createThemeController({ root });
  await controller.ready;
  expect(controller.getSnapshot()).toEqual({
    preference: "system",
    resolved: "light",
    persistence: "unavailable",
  });
  expect(await controller.setPreference("dark")).toBe(false);
  expect(root.dataset.theme).toBe("dark");
  controller.destroy();
});
