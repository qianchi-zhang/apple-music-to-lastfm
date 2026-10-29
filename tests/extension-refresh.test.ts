import { expect, it, vi } from "vitest";
import { createRefreshCoordinator } from "../apps/browser-extension/src/refresh-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("coalesces concurrent triggers into one read and permits a later refresh", async () => {
  const first = deferred<string>();
  const read = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue("later");
  const apply = vi.fn();
  const coordinator = createRefreshCoordinator<string>(read, apply);
  const pending = coordinator.run();
  expect(coordinator.run()).toBe(pending);
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  first.resolve("first");
  await pending;
  expect(apply).toHaveBeenCalledExactlyOnceWith("first");
  await coordinator.run();
  expect(read).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls).toEqual([["first"], ["later"]]);
});

it("does not apply a late response after switching installation or session", async () => {
  const old = deferred<string>();
  const read = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue("new account");
  const apply = vi.fn();
  const coordinator = createRefreshCoordinator<string>(read, apply);
  const previous = coordinator.run();
  coordinator.invalidate();
  await coordinator.run();
  old.resolve("old account");
  await previous;
  expect(apply.mock.calls).toEqual([["new account"]]);
});

it("an obsolete request finishing cannot clear the current in-flight read", async () => {
  const old = deferred<string>();
  const current = deferred<string>();
  const read = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise);
  const apply = vi.fn();
  const coordinator = createRefreshCoordinator<string>(read, apply);
  const previous = coordinator.run();
  coordinator.invalidate();
  const pending = coordinator.run();
  old.resolve("old");
  await previous;
  expect(coordinator.run()).toBe(pending);
  expect(read).toHaveBeenCalledTimes(2);
  current.resolve("current");
  await pending;
  expect(apply).toHaveBeenCalledExactlyOnceWith("current");
});

it("discards a response invalidated without immediately starting another request", async () => {
  const result = deferred<string>();
  const apply = vi.fn();
  const coordinator = createRefreshCoordinator(() => result.promise, apply);
  const pending = coordinator.run();
  coordinator.invalidate();
  result.resolve("obsolete");
  await pending;
  expect(apply).not.toHaveBeenCalled();
});

it("propagates current read failures and allows retry", async () => {
  const error = Error("offline");
  const read = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue("recovered");
  const apply = vi.fn();
  const coordinator = createRefreshCoordinator<string>(read, apply);
  await expect(coordinator.run()).rejects.toBe(error);
  expect(apply).not.toHaveBeenCalled();
  await coordinator.run();
  expect(apply).toHaveBeenCalledExactlyOnceWith("recovered");
});

it("suppresses obsolete failures so they cannot replace a new session's status", async () => {
  const old = deferred<string>();
  const apply = vi.fn();
  const coordinator = createRefreshCoordinator(
    vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue("current"),
    apply,
  );
  const previous = coordinator.run();
  coordinator.invalidate();
  await coordinator.run();
  old.reject(Error("old session expired"));
  await expect(previous).resolves.toBeUndefined();
  expect(apply).toHaveBeenCalledExactlyOnceWith("current");
});

it("cleans up after a synchronous read throw", async () => {
  let first = true;
  const coordinator = createRefreshCoordinator(() => {
    if (first) {
      first = false;
      throw Error("read failed");
    }
    return Promise.resolve("retried");
  }, vi.fn());
  await expect(coordinator.run()).rejects.toThrow("read failed");
  await expect(coordinator.run()).resolves.toBeUndefined();
});
