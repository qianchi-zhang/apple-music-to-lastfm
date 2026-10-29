import { ServiceError } from "./extension-errors";

const launchPath = "/api/v1/connections/lastfm/extension/authorize";
const resultPath = "/api/v1/connections/lastfm/extension/result";
const results = new Set([
  "connected",
  "cancelled",
  "invalid_flow",
  "lastfm_expired",
  "application_changed",
  "lastfm_unavailable",
  "lastfm_invalid_application",
  "lastfm_not_authorized",
  "lastfm_invalid_response",
  "save_failed",
]);

/** Only a same-instance, one-use browser handoff can open an authorization tab. */
export async function openLastfmAuthorization(
  origin: string,
  response: unknown,
  onComplete: (result: string) => Promise<void>,
): Promise<(closeTab?: boolean) => void> {
  const data = response as {
    browser_url?: unknown;
    callback_url?: unknown;
  } | null;
  let browser: URL, callback: URL;
  try {
    if (
      typeof data?.browser_url !== "string" ||
      typeof data.callback_url !== "string"
    )
      throw Error();
    browser = new URL(data.browser_url);
    callback = new URL(data.callback_url);
    if (
      browser.origin !== origin ||
      browser.protocol !== "https:" ||
      browser.pathname !== launchPath ||
      browser.username ||
      browser.password ||
      browser.hash ||
      Array.from(browser.searchParams.keys()).join() !== "flow" ||
      !/^[a-f0-9]{64}$/.test(browser.searchParams.get("flow") ?? "") ||
      callback.href !== origin + resultPath
    )
      throw Error();
  } catch {
    throw new ServiceError("invalid_response");
  }
  const owner = await chrome.tabs.getCurrent();
  let authorizationTab: number | undefined;
  let settled = false;
  const cleanup = () => {
    chrome.tabs.onUpdated.removeListener(updated);
    chrome.tabs.onRemoved.removeListener(removed);
  };
  const finish = (result: string, close: boolean) => {
    if (settled) return;
    settled = true;
    cleanup();
    void (async () => {
      try {
        await onComplete(result);
      } finally {
        if (typeof owner?.id === "number")
          await chrome.tabs.update(owner.id, { active: true }).catch(() => {});
        if (close && typeof authorizationTab === "number")
          await chrome.tabs.remove(authorizationTab).catch(() => {});
      }
    })().catch(() => {});
  };
  const inspect = (url?: string) => {
    if (!url) return;
    let value: URL;
    try {
      value = new URL(url);
    } catch {
      return;
    }
    if (
      value.origin !== callback.origin ||
      value.pathname !== callback.pathname
    )
      return;
    const result = value.searchParams.get("result") ?? "";
    finish(
      !value.hash &&
        Array.from(value.searchParams.keys()).join() === "result" &&
        results.has(result)
        ? result
        : "invalid_flow",
      true,
    );
  };
  const updated = (
    tabId: number,
    change: { url?: string; status?: string },
    tab: { id?: number; url?: string },
  ) => {
    if (tabId === authorizationTab) inspect(change.url ?? tab.url);
  };
  const removed = (tabId: number) => {
    if (tabId === authorizationTab) finish("closed", false);
  };
  chrome.tabs.onUpdated.addListener(updated);
  chrome.tabs.onRemoved.addListener(removed);
  try {
    const tab = await chrome.tabs.create({ url: browser.href });
    if (typeof tab.id !== "number")
      throw new ServiceError("lastfm_open_failed");
    authorizationTab = tab.id;
    inspect(tab.url);
  } catch {
    settled = true;
    cleanup();
    throw new ServiceError("lastfm_open_failed");
  }
  return (closeTab = true) => {
    settled = true;
    cleanup();
    if (closeTab && typeof authorizationTab === "number")
      void chrome.tabs.remove(authorizationTab).catch(() => {});
  };
}
