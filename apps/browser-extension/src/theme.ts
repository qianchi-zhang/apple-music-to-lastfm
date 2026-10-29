export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "theme-preference:v1";

export interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  persistence: "pending" | "saved" | "unavailable";
}

export interface ThemeStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(value: Record<string, unknown>): Promise<void>;
}

export interface ThemeMedia {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** Local display preference only: no service credentials, network or sync storage. */
export function createThemeController(
  options: {
    root?: HTMLElement;
    storage?: ThemeStorage;
    media?: ThemeMedia;
    onChange?: (snapshot: ThemeSnapshot) => void;
  } = {},
): {
  ready: Promise<void>;
  getSnapshot(): ThemeSnapshot;
  setPreference(value: ThemePreference): Promise<boolean>;
  destroy(): void;
} {
  const root =
    options.root ??
    (typeof document === "undefined" ? undefined : document.documentElement);
  const storage =
    options.storage ??
    (typeof chrome === "undefined" ? undefined : chrome.storage.local);
  let media = options.media;
  if (
    !media &&
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      // An unavailable system preference must not block the extension UI.
    }
  }
  let preference: ThemePreference = "system";
  let persistence: ThemeSnapshot["persistence"] = "pending";
  let revision = 0;
  let destroyed = false;
  let writes: Promise<void> = Promise.resolve();

  const getSnapshot = (): ThemeSnapshot => ({
    preference,
    resolved:
      preference === "system"
        ? media?.matches
          ? "dark"
          : "light"
        : preference,
    persistence,
  });
  function publish() {
    if (destroyed) return;
    const snapshot = getSnapshot();
    if (root) {
      root.dataset.theme = snapshot.resolved;
      root.dataset.themePreference = snapshot.preference;
      root.style.colorScheme = snapshot.resolved;
    }
    options.onChange?.(snapshot);
  }
  const onSystemChange = () => {
    if (preference === "system") publish();
  };
  media?.addEventListener("change", onSystemChange);
  publish();

  const ready = Promise.resolve().then(async () => {
    try {
      if (!storage) throw Error("theme_storage_unavailable");
      const saved = await storage.get(THEME_STORAGE_KEY);
      if (destroyed || revision !== 0) return;
      preference = parseThemePreference(saved[THEME_STORAGE_KEY]);
      persistence = "saved";
    } catch {
      if (destroyed || revision !== 0) return;
      persistence = "unavailable";
    }
    publish();
  });

  return {
    ready,
    getSnapshot,
    setPreference(value) {
      if (destroyed) return Promise.resolve(false);
      const selection = parseThemePreference(value);
      const currentRevision = ++revision;
      preference = selection;
      persistence = "pending";
      publish();
      const result = writes.then(async () => {
        if (destroyed) return false;
        let saved = false;
        try {
          if (!storage) throw Error("theme_storage_unavailable");
          await storage.set({ [THEME_STORAGE_KEY]: selection });
          saved = true;
        } catch {
          // Retain the selected appearance for this tab and report unsaved state.
        }
        if (!destroyed && revision === currentRevision) {
          persistence = saved ? "saved" : "unavailable";
          publish();
        }
        return saved;
      });
      writes = result.then(() => {});
      return result;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      media?.removeEventListener("change", onSystemChange);
    },
  };
}
