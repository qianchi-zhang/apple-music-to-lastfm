import { test } from "vitest";
import { createHarness, regressionWorker } from "../support";
test("formal-release-match: baseline 0.3.49 behavior", async () => {
  const api: any = createHarness();
  const testLog: any = (..._args: any[]) => {};
  const realFetch: any = globalThis.fetch;
  const musicBrainzFixture: any = {
    recordings: [
      {
        id: "54cd207c-14c8-4879-9e36-6b7eb9bd2e8e",
        title: "月亮代表誰的心",
        length: 206173,
        score: 100,
        "artist-credit": [{ name: "陶喆" }],
        releases: [
          {
            id: "b3cf66e4-0938-4ca4-b8c4-3cd86a7b47b8",
            title: "Soul Power Live",
            status: "Official",
            date: "2003-12-19",
            country: "TW",
            "release-group": {
              id: "a246d89c-a4fd-3822-ade2-709751d46083",
              "primary-type": "Album",
              "secondary-types": ["Live"],
            },
          },
        ],
      },
      {
        id: "6a444a38-d4b9-433e-8c7d-439e26d08d89",
        title: "月亮代表誰的心",
        length: 204986,
        score: 100,
        "artist-credit": [{ name: "陶喆" }],
        releases: [
          {
            id: "bade1adc-6282-427e-802d-b523ab3ad434",
            title: "黑色柳丁",
            status: "Official",
            date: "2002-08-09",
            country: "TW",
            "release-group": {
              id: "ada64ee0-8bd4-3f23-acc0-a3e937431bf0",
              "primary-type": "Album",
              "secondary-types": [],
            },
          },
        ],
      },
    ],
  };
  const lastFmAlbums: any = {
    "Soul Power Live": {
      name: "Soul Power Live",
      artist: "陶喆",
      mbid: "92f2adb8-665c-42e9-a351-591f8666336e",
      image: [
        { "#text": "https://lastfm-img.example/small.jpg" },
        { "#text": "https://lastfm-img.example/cover.jpg" },
      ],
      tracks: {
        track: [{ name: "Moon Over My Heart 月亮代表誰的心", duration: 206 }],
      },
    },
    黑色柳丁: {
      name: "黑色柳丁",
      artist: "陶喆",
      mbid: "",
      image: [
        { "#text": "https://lastfm-img.example/small.jpg" },
        { "#text": "https://lastfm-img.example/studio.jpg" },
      ],
      tracks: { track: [{ name: "月亮代表誰的心", duration: 205 }] },
    },
  };
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    if (url.hostname === "musicbrainz.org") {
      return new Response(JSON.stringify(musicBrainzFixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.searchParams.get("method") === "album.getInfo") {
      const album: any = lastFmAlbums[url.searchParams.get("album")];
      return new Response(JSON.stringify(album ? { album } : { error: 6 }), {
        status: album ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  const sourceTrack: any = {
    name: "月亮代表誰的心 (Live)",
    artist: "陶喆",
    album_artist: "陶喆",
    album: "Soul Power (現場原音專輯)",
    duration_ms: 206000,
  };
  const result: any = await api.resolveFormalReleaseTrackForArtwork(
    sourceTrack,
    "陶喆",
    "test-api-key",
    null,
  );
  testLog(
    JSON.stringify(
      {
        name: result?.name,
        artist: result?.artist,
        album: result?.album,
        mbid: result?.mbid,
        release_mbid: result?.release_mbid,
        artwork_match: result?._lastfm_artwork_match,
        formal_release_match: result?._lastfm_formal_release_match,
      },
      null,
      2,
    ),
  );
  if (
    result?.name !== "Moon Over My Heart 月亮代表誰的心" ||
    result?.artist !== "陶喆" ||
    result?.album !== "Soul Power Live" ||
    result?.mbid !== "54cd207c-14c8-4879-9e36-6b7eb9bd2e8e" ||
    result?.release_mbid !== "b3cf66e4-0938-4ca4-b8c4-3cd86a7b47b8" ||
    result?._lastfm_artwork_match !== true ||
    result?._lastfm_formal_release_match !== true
  ) {
    throw new Error(
      "Formal release matcher did not select the expected canonical release",
    );
  }
  const studioResult: any = await api.resolveFormalReleaseTrackForArtwork(
    {
      ...sourceTrack,
      name: "月亮代表誰的心",
      album: "黑色柳丁",
      duration_ms: 204986,
    },
    "陶喆",
    "test-api-key",
    null,
  );
  testLog(
    JSON.stringify(
      {
        studio_name: studioResult?.name,
        studio_album: studioResult?.album,
        studio_mbid: studioResult?.mbid,
        studio_release_mbid: studioResult?.release_mbid,
      },
      null,
      2,
    ),
  );
  if (
    studioResult?.album !== "黑色柳丁" ||
    studioResult?.mbid !== "6a444a38-d4b9-433e-8c7d-439e26d08d89" ||
    /(?:\blive\b|现场|現場|演唱会|演唱會)/iu.test(
      `${studioResult?.name ?? ""} ${studioResult?.album ?? ""}`,
    )
  ) {
    throw new Error("Live/studio release protection failed");
  }
  globalThis.fetch = realFetch;
});
