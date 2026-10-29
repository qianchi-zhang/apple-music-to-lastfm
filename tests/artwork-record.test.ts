import { expect, it } from "vitest";
import {
  artworkLookup,
  isAppleTrackId,
} from "../packages/contracts/src/artwork-record";

it("prefers the source Apple ID even when matched catalogue metadata differs", () => {
  expect(
    artworkLookup({
      track_id: "12345",
      catalog_id: "98765",
      artist: "Matched artist",
      album: "Matched album",
    }),
  ).toEqual({ kind: "track_id", id: "12345" });
  expect(
    artworkLookup({ track_id: "i.originalLibrary", catalog_id: null }),
  ).toEqual({ kind: "track_id", id: "i.originalLibrary" });
  expect(artworkLookup({ catalog_id: "98765" })).toEqual({
    kind: "catalog_id",
    id: "98765",
  });
  expect(
    artworkLookup({ artist: "Artist", track: "Song", album: "Album" }),
  ).toBeNull();
});

it.each([
  "",
  "0",
  "001",
  "9".repeat(21),
  "i.",
  "i." + "a".repeat(127),
  "i.unsafe/track",
  "i.unsafe?query=1",
  "https://private.test",
  null,
  12345,
])("rejects invalid source ID %j", (value) => {
  expect(isAppleTrackId(value)).toBe(false);
  expect(artworkLookup({ track_id: value })).toBeNull();
});
