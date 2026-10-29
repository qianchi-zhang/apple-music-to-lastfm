import { beforeEach, vi } from "vitest";
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected live request in test");
    }),
  );
});
