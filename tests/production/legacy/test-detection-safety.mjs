import fs from "node:fs";

let source = fs.readFileSync(new URL("./worker-fixed.js", import.meta.url), "utf8");
source = source.replace(/export\s*\{\s*ScrobbleCoordinator,\s*index_default as default\s*\};\s*$/, "");
source += "\nglobalThis.__detectionSafety = { appleHistoryTrackIdentity, detectPlays, fallbackDetect, filterImplausibleInferredRepeats };\n";
(0, eval)(source);

const api = globalThis.__detectionSafety;
const track = (id, duration_ms = 240000) => ({ id, name: id, duration_ms });

const previous = [track("expired-head"), track("a"), track("b"), track("c")];
const irregularCurrent = [track("new"), track("a"), track("b"), track("c")];
const irregular = api.detectPlays(irregularCurrent, previous, 180);
if (irregular.plays.length !== 1 || irregular.plays[0].track.id !== "new" || irregular.plays[0].kind !== "new") {
  throw new Error(`Irregular history shift emitted false repeats: ${JSON.stringify(irregular.plays)}`);
}

const normalCurrent = [track("new-2"), track("new-1"), ...previous];
const normal = api.detectPlays(normalCurrent, previous, 600);
if (normal.plays.map((play) => play.track.id).join(",") !== "new-1,new-2") {
  throw new Error(`Normal history shift was not preserved: ${JSON.stringify(normal.plays)}`);
}

const catalogHistory = [
  { id: "101", type: "songs", catalog_id: "101", isrc: "TEST00000001", name: "same song" },
  { id: "102", type: "songs", catalog_id: "102", isrc: "TEST00000002", name: "anchor" }
];
const libraryHistory = [
  { id: "i.library-101", type: "library-songs", catalog_id: "101", isrc: "TEST00000001", name: "same song" },
  { id: "i.library-102", type: "library-songs", catalog_id: "102", isrc: "TEST00000002", name: "anchor" }
];
const representationFlip = api.detectPlays(libraryHistory, catalogHistory, 180);
if (representationFlip.plays.length !== 0 || api.appleHistoryTrackIdentity(libraryHistory[0]) !== api.appleHistoryTrackIdentity(catalogHistory[0])) {
  throw new Error(`Apple catalog/library representation flip emitted duplicate plays: ${JSON.stringify(representationFlip.plays)}`);
}

const representationFlipWithNewHead = api.detectPlays([
  { id: "i.library-103", type: "library-songs", catalog_id: "103", isrc: "TEST00000003", name: "actual new" },
  ...libraryHistory
], catalogHistory, 180);
if (representationFlipWithNewHead.plays.length !== 1 || representationFlipWithNewHead.plays[0].track.catalog_id !== "103") {
  throw new Error(`Stable Apple identity hid a legitimate new head: ${JSON.stringify(representationFlipWithNewHead.plays)}`);
}

const burst = Array.from({ length: 28 }, (_, index) => ({ track: track(`repeat-${index}`), kind: "repeat" }));
burst.push({ track: track("legitimate-new"), kind: "new" });
const guarded = api.filterImplausibleInferredRepeats(burst, 180);
if (guarded.dropped !== 28 || guarded.plays.length !== 1 || guarded.plays[0].track.id !== "legitimate-new") {
  throw new Error(`Implausible repeat burst was not blocked: ${JSON.stringify(guarded)}`);
}

const plausibleRepeat = api.filterImplausibleInferredRepeats([{ track: track("one-repeat", 240000), kind: "repeat" }], 180);
if (plausibleRepeat.dropped !== 0 || plausibleRepeat.plays.length !== 1) {
  throw new Error("A single plausible repeat was incorrectly blocked");
}

console.log(JSON.stringify({
  ok: true,
  irregular_false_repeats: 0,
  normal_new_plays: normal.plays.length,
  blocked_repeat_burst: guarded.dropped,
  catalog_library_representation_flip_duplicates: representationFlip.plays.length,
  preserved_legitimate_new: guarded.plays[0].track.id
}, null, 2));
