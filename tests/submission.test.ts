import { expect, it, vi } from "vitest";
import { submitLastfm } from "../packages/providers/src/submission";
const play = {
  artist: "a",
  track: "t",
  album: "b",
  duration_ms: 180000,
  timestamp: new Date("2026-09-08T00:00:00Z"),
};
const response = (rows: any[], accepted: number, ignored: number) =>
  new Response(
    JSON.stringify({
      scrobbles: {
        "@attr": { accepted: String(accepted), ignored: String(ignored) },
        scrobble: rows,
      },
    }),
  );
it("missing per-item result is never default accepted", async () => {
  const f = vi.fn(async () =>
    response([{ ignoredMessage: { code: "0" } }], 1, 0),
  );
  const r = await submitLastfm([play, play], "a", "s", "k", f);
  expect(r.items.map((i) => i.status)).toEqual(["accepted", "uncertain"]);
});
it("conflicting counts are uncertain", async () => {
  const r = await submitLastfm([play], "a", "s", "k", async () =>
    response([{ ignoredMessage: { code: "0" } }], 0, 1),
  );
  expect(r.items[0].status).toBe("uncertain");
});
it("network and non-JSON success responses are uncertain", async () => {
  expect(
    (
      await submitLastfm([play], "a", "s", "k", async () => {
        throw Error("timeout");
      })
    ).items[0].status,
  ).toBe("uncertain");
  expect(
    (
      await submitLastfm(
        [play],
        "a",
        "s",
        "k",
        async () => new Response("oops"),
      )
    ).items[0].status,
  ).toBe("uncertain");
});
it("retains returned platform spelling separately from submitted labels", async () => {
  const r = await submitLastfm([play], "a", "s", "k", async () =>
    response(
      [{ ignoredMessage: { code: "0" }, artist: { "#text": "Corrected" } }],
      1,
      0,
    ),
  );
  expect(r.items[0].returned?.artist).toBe("Corrected");
  expect(play.artist).toBe("a");
});
it("chunk failures preserve index alignment for later accepted rows", async () => {
  let n = 0;
  const r = await submitLastfm(
    Array.from({ length: 51 }, () => play),
    "a",
    "s",
    "k",
    async () =>
      ++n === 1
        ? new Response("", { status: 503 })
        : response([{ ignoredMessage: { code: "0" } }], 1, 0),
  );
  expect(r.items).toHaveLength(51);
  expect(r.items[49].status).toBe("failed");
  expect(r.items[50].status).toBe("accepted");
});
