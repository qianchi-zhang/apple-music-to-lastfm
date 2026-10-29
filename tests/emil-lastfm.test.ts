import { afterEach, expect, it, vi } from "vitest";
import { openLastfmAuthorization } from "../apps/browser-extension/src/emil-lastfm";

const origin = "https://ams-" + "b".repeat(24) + ".preview.workers.dev";
const launchPath = "/api/v1/connections/lastfm/extension/authorize";
const resultPath = "/api/v1/connections/lastfm/extension/result";
const browserUrl = origin + launchPath + "?flow=" + "a".repeat(64);
const callbackUrl = origin + resultPath;
const validResponse = { browser_url: browserUrl, callback_url: callbackUrl };

afterEach(() => vi.unstubAllGlobals());

function harness() {
  const updated = new Set<(...args: any[]) => void>();
  const removed = new Set<(...args: any[]) => void>();
  const create = vi.fn(async (options: { url: string }) => ({
    id: 42,
    url: options.url,
  }));
  const getCurrent = vi.fn(async () => ({ id: 8 }));
  const update = vi.fn(
    async (_id: number, _options: { active: boolean }) => ({}),
  );
  const remove = vi.fn(async (_id: number) => {});
  vi.stubGlobal("chrome", {
    tabs: {
      create,
      getCurrent,
      update,
      remove,
      onUpdated: {
        addListener: (fn: (...args: any[]) => void) => updated.add(fn),
        removeListener: (fn: (...args: any[]) => void) => updated.delete(fn),
      },
      onRemoved: {
        addListener: (fn: (...args: any[]) => void) => removed.add(fn),
        removeListener: (fn: (...args: any[]) => void) => removed.delete(fn),
      },
    },
  });
  return {
    create,
    getCurrent,
    update,
    remove,
    updated,
    removed,
    emitUpdated: (id: number, url: string, fromTab = false) => {
      for (const listener of updated)
        listener(id, fromTab ? {} : { url }, { id, url });
    },
    emitRemoved: (id: number) => {
      for (const listener of removed) listener(id, {});
    },
  };
}

it.each([
  null,
  {},
  {
    ...validResponse,
    browser_url: "https://evil.test" + launchPath + "?flow=" + "a".repeat(64),
  },
  { ...validResponse, browser_url: browserUrl.replace("https:", "http:") },
  {
    ...validResponse,
    browser_url: browserUrl.replace("https://", "https://user:password@"),
  },
  { ...validResponse, browser_url: origin + "/setup?flow=" + "a".repeat(64) },
  {
    ...validResponse,
    browser_url: browserUrl + "&return_url=https://evil.test",
  },
  { ...validResponse, browser_url: browserUrl + "&flow=" + "b".repeat(64) },
  { ...validResponse, browser_url: browserUrl + "#next" },
  {
    ...validResponse,
    browser_url: origin + launchPath + "?flow=" + "a".repeat(63),
  },
  {
    ...validResponse,
    browser_url: origin + launchPath + "?flow=" + "z".repeat(64),
  },
  { ...validResponse, callback_url: "https://evil.test" + resultPath },
  { ...validResponse, callback_url: callbackUrl + "?result=connected" },
  { ...validResponse, callback_url: callbackUrl + "#next" },
  { ...validResponse, callback_url: origin + "/setup" },
])(
  "rejects an untrusted browser handoff before touching browser tabs: %j",
  async (response) => {
    const h = harness();
    const complete = vi.fn(async (_result: string) => {});
    await expect(
      openLastfmAuthorization(origin, response, complete),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(h.getCurrent).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(h.updated.size).toBe(0);
    expect(h.removed.size).toBe(0);
  },
);

it("ignores other tabs and origins, then closes only its own completion tab and focuses the owner once", async () => {
  const h = harness();
  const complete = vi.fn(async (_result: string) => {});
  await openLastfmAuthorization(origin, validResponse, complete);
  expect(h.create).toHaveBeenCalledWith({ url: browserUrl });
  h.emitUpdated(999, callbackUrl + "?result=connected");
  h.emitUpdated(42, "https://evil.test" + resultPath + "?result=connected");
  h.emitUpdated(42, origin + "/setup?lastfm=connected");
  h.emitUpdated(42, origin + resultPath + "/extra?result=connected");
  h.emitRemoved(999);
  expect(complete).not.toHaveBeenCalled();
  expect(h.remove).not.toHaveBeenCalled();
  h.emitUpdated(42, callbackUrl + "?result=connected", true);
  await vi.waitFor(() => expect(h.remove).toHaveBeenCalledWith(42));
  expect(complete).toHaveBeenCalledExactlyOnceWith("connected");
  expect(h.update).toHaveBeenCalledExactlyOnceWith(8, { active: true });
  expect(h.remove).toHaveBeenCalledOnce();
  expect(h.updated.size).toBe(0);
  expect(h.removed.size).toBe(0);
  h.emitUpdated(42, callbackUrl + "?result=cancelled");
  h.emitRemoved(42);
  expect(complete).toHaveBeenCalledOnce();
});

it.each([
  "cancelled",
  "invalid_flow",
  "lastfm_expired",
  "application_changed",
  "lastfm_unavailable",
  "lastfm_invalid_application",
  "lastfm_not_authorized",
  "lastfm_invalid_response",
  "save_failed",
])(
  "passes the fixed error %s back for an authoritative backend refresh",
  async (result) => {
    const h = harness();
    const complete = vi.fn(async (_result: string) => {});
    await openLastfmAuthorization(origin, validResponse, complete);
    h.emitUpdated(42, callbackUrl + "?result=" + result);
    await vi.waitFor(() => expect(h.remove).toHaveBeenCalledWith(42));
    expect(complete).toHaveBeenCalledExactlyOnceWith(result);
  },
);

it.each([
  "?result=connected&result=cancelled",
  "?result=connected&return_url=https://evil.test",
  "?result=connected#next",
  "?result=unexpected-private-response",
  "?token=should-never-be-used",
  "",
])(
  "treats a malformed completion marker as invalid rather than success: %s",
  async (query) => {
    const h = harness();
    const complete = vi.fn(async (_result: string) => {});
    await openLastfmAuthorization(origin, validResponse, complete);
    h.emitUpdated(42, callbackUrl + query);
    await vi.waitFor(() => expect(h.remove).toHaveBeenCalledWith(42));
    expect(complete).toHaveBeenCalledExactlyOnceWith("invalid_flow");
  },
);

it("reports a user-closed tab once without attempting to close it again", async () => {
  const h = harness();
  const complete = vi.fn(async (_result: string) => {});
  await openLastfmAuthorization(origin, validResponse, complete);
  h.emitRemoved(42);
  await vi.waitFor(() =>
    expect(h.update).toHaveBeenCalledWith(8, { active: true }),
  );
  expect(complete).toHaveBeenCalledExactlyOnceWith("closed");
  expect(h.remove).not.toHaveBeenCalled();
  expect(h.updated.size).toBe(0);
  expect(h.removed.size).toBe(0);
});

it("disposes a superseded authorization without reporting success or acting on later tab events", async () => {
  const h = harness();
  const complete = vi.fn(async (_result: string) => {});
  const dispose = await openLastfmAuthorization(
    origin,
    validResponse,
    complete,
  );
  dispose();
  h.emitUpdated(42, callbackUrl + "?result=connected");
  h.emitRemoved(42);
  expect(complete).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
  expect(h.remove).toHaveBeenCalledExactlyOnceWith(42);
  expect(h.updated.size).toBe(0);
  expect(h.removed.size).toBe(0);
});

it("still restores focus and closes its tab if backend confirmation rejects", async () => {
  const h = harness();
  const complete = vi.fn(async (_result: string) => {
    throw Error("fixture network failure");
  });
  await openLastfmAuthorization(origin, validResponse, complete);
  h.emitUpdated(42, callbackUrl + "?result=connected");
  await vi.waitFor(() => expect(h.remove).toHaveBeenCalledWith(42));
  expect(h.update).toHaveBeenCalledWith(8, { active: true });
  expect(complete).toHaveBeenCalledOnce();
});

it("inspects an already-completed tab returned by Chrome without waiting for a missing URL event", async () => {
  const h = harness();
  h.create.mockResolvedValueOnce({
    id: 42,
    url: callbackUrl + "?result=connected",
  });
  const complete = vi.fn(async (_result: string) => {});
  await openLastfmAuthorization(origin, validResponse, complete);
  await vi.waitFor(() => expect(h.remove).toHaveBeenCalledWith(42));
  expect(complete).toHaveBeenCalledExactlyOnceWith("connected");
});

it.each(["rejected", "missing-id"])(
  "cleans event listeners after Chrome fails to create an authorization tab: %s",
  async (mode) => {
    const h = harness();
    if (mode === "rejected")
      h.create.mockRejectedValueOnce(Error("private browser failure"));
    else h.create.mockResolvedValueOnce({ url: browserUrl } as never);
    const complete = vi.fn(async (_result: string) => {});
    await expect(
      openLastfmAuthorization(origin, validResponse, complete),
    ).rejects.toMatchObject({ code: "lastfm_open_failed" });
    expect(complete).not.toHaveBeenCalled();
    expect(h.updated.size).toBe(0);
    expect(h.removed.size).toBe(0);
    expect(h.remove).not.toHaveBeenCalled();
  },
);
