import { test } from "vitest";
import { createHarness, regressionWorker } from "../support";
test("detection-safety: baseline 0.3.49 behavior", async () => {
  const api: any = createHarness();
  const testLog: any = (..._args: any[]) => {};
  const track: any = (id?: any, duration_ms: any = 240000) => ({
    id,
    name: id,
    duration_ms,
  });
  const previous: any = [
    track("expired-head"),
    track("a"),
    track("b"),
    track("c"),
  ];
  const irregularCurrent: any = [
    track("new"),
    track("a"),
    track("b"),
    track("c"),
  ];
  const irregular: any = api.detectPlays(irregularCurrent, previous, 180);
  if (
    irregular.plays.length !== 1 ||
    irregular.plays[0].track.id !== "new" ||
    irregular.plays[0].kind !== "new"
  ) {
    throw new Error(
      `Irregular history shift emitted false repeats: ${JSON.stringify(irregular.plays)}`,
    );
  }
  const normalCurrent: any = [track("new-2"), track("new-1"), ...previous];
  const normal: any = api.detectPlays(normalCurrent, previous, 600);
  if (
    normal.plays.map((play?: any) => play.track.id).join(",") !== "new-1,new-2"
  ) {
    throw new Error(
      `Normal history shift was not preserved: ${JSON.stringify(normal.plays)}`,
    );
  }
  const burst: any = Array.from({ length: 28 }, (_?: any, index?: any) => ({
    track: track(`repeat-${index}`),
    kind: "repeat",
  }));
  burst.push({ track: track("legitimate-new"), kind: "new" });
  const guarded: any = api.filterImplausibleInferredRepeats(burst, 180);
  if (
    guarded.dropped !== 28 ||
    guarded.plays.length !== 1 ||
    guarded.plays[0].track.id !== "legitimate-new"
  ) {
    throw new Error(
      `Implausible repeat burst was not blocked: ${JSON.stringify(guarded)}`,
    );
  }
  const plausibleRepeat: any = api.filterImplausibleInferredRepeats(
    [{ track: track("one-repeat", 240000), kind: "repeat" }],
    180,
  );
  if (plausibleRepeat.dropped !== 0 || plausibleRepeat.plays.length !== 1) {
    throw new Error("A single plausible repeat was incorrectly blocked");
  }
  testLog(
    JSON.stringify(
      {
        ok: true,
        irregular_false_repeats: 0,
        normal_new_plays: normal.plays.length,
        blocked_repeat_burst: guarded.dropped,
        preserved_legitimate_new: guarded.plays[0].track.id,
      },
      null,
      2,
    ),
  );
});
