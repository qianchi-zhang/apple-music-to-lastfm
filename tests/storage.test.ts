import { expect, it, vi } from "vitest";
import { CoordinatedKvStore } from "../packages/storage/src/index";
it("durable checkpoints survive stale KV reads and actor restarts", async () => {
  const values = new Map<string, unknown>();
  const checkpoint = {
    get: async <T>(k: string) => values.get(k) as T | undefined,
    put: async <T>(k: string, v: T) => {
      values.set(k, structuredClone(v));
    },
  };
  const kv = {
    get: async () => JSON.stringify({ revision: 0 }),
    put: async () => {},
  };
  await new CoordinatedKvStore(kv, checkpoint).put("profile:v1", {
    revision: 1,
  });
  expect(
    await new CoordinatedKvStore(kv, checkpoint).get("profile:v1"),
  ).toEqual({ revision: 1 });
});
it("mirror failure cannot discard a durably accepted submission", async () => {
  let saved: unknown;
  const warn = vi.fn();
  const checkpoint = {
    get: async <T>() => saved as T | undefined,
    put: async <T>(_k: string, v: T) => {
      saved = v;
    },
  };
  const store = new CoordinatedKvStore(
    {
      get: async () => null,
      put: async () => {
        throw Error("KV unavailable");
      },
    },
    checkpoint,
    warn,
  );
  await store.put("ledger:v1", { accepted: true });
  expect(await store.get("ledger:v1")).toEqual({ accepted: true });
  expect(warn).toHaveBeenCalledTimes(1);
});
