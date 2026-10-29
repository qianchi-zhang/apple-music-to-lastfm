import { test } from "vitest";
import { createHarness, regressionWorker } from "../support";
test("identity-chain: baseline 0.3.49 behavior", async () => {
  const api: any = createHarness();
  const testLog: any = (..._args: any[]) => {};
  const initialFetch: any = globalThis.fetch;
  let transientMusicBrainzAttempts: any = 0;
  globalThis.fetch = async () => {
    transientMusicBrainzAttempts += 1;
    if (transientMusicBrainzAttempts === 1)
      throw new DOMException("timed out", "TimeoutError");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const transientMusicBrainzResult: any = await api.getMusicBrainzJson(
    new URL("https://musicbrainz.org/ws/2/recording/test"),
  );
  globalThis.fetch = initialFetch;
  if (!transientMusicBrainzResult?.ok || transientMusicBrainzAttempts !== 2) {
    throw new Error("Transient MusicBrainz network failure was not retried");
  }
  let absentIsrcAttempts: any = 0;
  globalThis.fetch = async () => {
    absentIsrcAttempts += 1;
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
  const absentIsrcRecordings: any =
    await api.lookupMusicBrainzRecordingsByIsrc("FR6V80094545");
  globalThis.fetch = initialFetch;
  if (absentIsrcRecordings.length !== 0 || absentIsrcAttempts !== 1) {
    throw new Error(
      "Definitive MusicBrainz ISRC 404 was treated as a transient failure",
    );
  }
  if (
    !api.shouldDeferIdentityNormalizationFailure(
      new Error("musicbrainz_identity_transient_failure"),
    ) ||
    api.shouldDeferIdentityNormalizationFailure(
      new Error("musicbrainz_no_match"),
    )
  ) {
    throw new Error(
      "Transient identity failures are not distinguished from confirmed misses",
    );
  }
  const xuSource: any = {
    id: "1487109327",
    artist: "徐佳莹",
    album_artist: "徐佳莹",
    name: "被动 (feat. 伍佰) [Live]",
    album: "徐佳莹是日救星演唱会 (Live)",
    duration_ms: 285550,
    isrc: "TWJ021900116",
    _apple_storefront: "cn",
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
    _apple_release_date: "2019-12-06",
    _apple_album_track_count: 31,
    _apple_track_number: 16,
  };
  const xuNative: any = {
    ...xuSource,
    id: "1487091672",
    artist: "徐佳瑩",
    album_artist: "徐佳瑩",
    name: "被動 (feat. 伍佰) [Live]",
    album: "徐佳瑩是日救星演唱會 (Live)",
    _apple_storefront: "tw",
    _metadata_source: "zh-Hant-TW",
    _is_source_storefront: false,
  };
  if (!api.sameAppleRelease(xuSource, xuNative))
    throw new Error("Equivalent CN/TW Apple release was rejected");
  if (
    api.choosePreferredAppleTrack(xuSource, [xuSource, xuNative]).album !==
    xuNative.album
  )
    throw new Error("TW native metadata was not preferred for TW ISRC");
  if (
    api.sameAppleRelease(xuSource, {
      ...xuNative,
      album: "Another Concert",
      name: "被動",
      _apple_album_track_count: 20,
    })
  )
    throw new Error("Wrong live/release candidate was accepted");
  const cheerSource: any = {
    id: "1598248910",
    artist: "陈绮贞",
    album_artist: "陈绮贞",
    name: "台北某个地方",
    album: "沙发海",
    duration_ms: 256027,
    isrc: "TWK011800019",
    _apple_storefront: "cn",
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
    _apple_release_date: "2018-12-24",
    _apple_album_upc: "4711281403508",
    _apple_album_track_count: 10,
    _apple_track_number: 4,
  };
  const cheerNative: any = {
    ...cheerSource,
    id: "1444602076",
    artist: "陳綺貞",
    album_artist: "陳綺貞",
    name: "台北某個地方",
    album: "沙發海",
    _apple_storefront: "tw",
    _metadata_source: "zh-Hant-TW",
    _is_source_storefront: false,
    _apple_release_date: "2018-12-11",
    _apple_album_upc: "4710255630605",
  };
  const cheerEvidence: any = api.appleReleaseEquivalenceEvidence(
    cheerSource,
    cheerNative,
  );
  if (!cheerEvidence.matches || !cheerEvidence.requires_musicbrainz)
    throw new Error(
      "Valid regional date/UPC variance was not retained for MusicBrainz confirmation",
    );
  const cheerPending: any = {
    ...cheerNative,
    _apple_release_equivalence_requires_musicbrainz: true,
  };
  if (
    api.filterMusicBrainzConfirmedAppleVariants(
      [cheerSource, cheerPending],
      null,
    ).length !== 1
  )
    throw new Error("Unconfirmed regional Apple candidate was trusted");
  const cheerIdentity: any = {
    release_group_mbid: "c6af3dfb-e48a-4d3f-b184-dbfc1863f384",
    album: "沙發海",
    release_group: "沙發海",
  };
  const cheerConfirmed: any = api.filterMusicBrainzConfirmedAppleVariants(
    [cheerSource, cheerPending],
    cheerIdentity,
  );
  if (
    cheerConfirmed.length !== 2 ||
    api.choosePreferredAppleTrack(cheerSource, cheerConfirmed).artist !==
      "陳綺貞"
  )
    throw new Error(
      "MusicBrainz-confirmed native Cheer Chen metadata was not selected",
    );
  if (
    api.filterMusicBrainzConfirmedAppleVariants([cheerSource, cheerPending], {
      ...cheerIdentity,
      album: "陳綺貞精選",
      release_group: "陳綺貞精選",
    }).length !== 1
  )
    throw new Error(
      "Wrong MusicBrainz release group confirmed a regional Apple candidate",
    );
  if (
    api.sameAppleRelease(cheerSource, {
      ...cheerNative,
      _apple_album_track_count: 15,
    })
  )
    throw new Error(
      "Compilation-like Apple candidate with a different track count was accepted",
    );
  if (
    api.sameAppleRelease(cheerSource, {
      ...cheerNative,
      _apple_release_date: "2020-12-11",
    })
  )
    throw new Error(
      "Apple candidate with an unreasonable release-date gap was accepted",
    );
  const cheerRecording: any = {
    id: "3330486c-cd60-401f-9817-524402e87336",
    title: "台北某個地方",
    length: 256000,
    "artist-credit": [{ name: "陳綺貞" }],
  };
  const cheerRelease: any = {
    id: "21c81c00-2acf-4ffb-a562-5496f4f770ea",
    title: "沙發海",
    status: "Official",
    date: "2018-12-11",
    country: "TW",
    "release-group": {
      id: cheerIdentity.release_group_mbid,
      title: "沙發海",
      "primary-type": "Album",
      "secondary-types": [],
    },
    media: [
      {
        format: "Digital Media",
        "track-count": 10,
        tracks: [{ title: "台北某個地方", position: 4, length: 256000 }],
      },
    ],
  };
  if (
    !api.scoreMusicBrainzIdentityCandidate(
      cheerRecording,
      cheerRelease,
      [cheerSource, cheerNative],
      true,
      true,
    )
  )
    throw new Error(
      "MusicBrainz did not confirm the regional 沙發海 release group",
    );
  const zhangSource: any = {
    artist: "张震岳",
    album_artist: "张震岳",
    name: "爱的初体验",
    album: "这个下午很无聊",
    duration_ms: 242093,
    isrc: "TWB879702703",
    catalog_id: "153051320",
    _apple_storefront: "cn",
    _apple_album_id: "153050820",
    _apple_album_upc: "4715122007191",
    _apple_release_date: "1997-10-30",
    _apple_album_track_count: 11,
    _apple_track_number: 3,
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
  };
  const zhangNative: any = {
    ...zhangSource,
    artist: "張震嶽",
    album_artist: "張震嶽",
    name: "愛的初體驗",
    album: "這個下午很無聊",
    _apple_storefront: "tw",
    _metadata_source: "zh-Hant-TW",
    _is_source_storefront: false,
  };
  const zhangEvidence: any = api.appleReleaseEquivalenceEvidence(
    zhangSource,
    zhangNative,
  );
  if (
    !zhangEvidence.matches ||
    !zhangEvidence.exact_apple_catalog_release ||
    zhangEvidence.requires_musicbrainz
  ) {
    throw new Error("Exact Apple catalog release localization was not trusted");
  }
  const zhangDifferentAlbum: any = api.appleReleaseEquivalenceEvidence(
    zhangSource,
    { ...zhangNative, _apple_album_id: "different-album" },
  );
  if (
    !zhangDifferentAlbum.matches ||
    !zhangDifferentAlbum.requires_musicbrainz ||
    zhangDifferentAlbum.exact_apple_catalog_release
  ) {
    throw new Error(
      "Different Apple album resource bypassed MusicBrainz confirmation",
    );
  }
  const zhangDifferentUpc: any = api.appleReleaseEquivalenceEvidence(
    zhangSource,
    { ...zhangNative, _apple_album_upc: "different-upc" },
  );
  if (
    !zhangDifferentUpc.matches ||
    !zhangDifferentUpc.requires_musicbrainz ||
    zhangDifferentUpc.exact_apple_catalog_release
  ) {
    throw new Error("Different Apple UPC bypassed MusicBrainz confirmation");
  }
  const fetchBeforeRecentCatalogIdTest: any = globalThis.fetch;
  globalThis.fetch = async (input?: any) => {
    const url: any = String(input);
    if (!url.includes("/me/recent/played/tracks"))
      throw new Error(`Unexpected recent-play request: ${url}`);
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "library-crowd",
            type: "library-songs",
            attributes: {
              name: "100种生活",
              artistName: "卢广仲",
              albumArtistName: "卢广仲",
              albumName: "100种生活",
              durationInMillis: 287427,
              playParams: { catalogId: "799184025" },
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const recentWithCatalogId: any = await api.fetchRecentlyPlayed(
    "dev-token",
    "user-token",
  );
  globalThis.fetch = fetchBeforeRecentCatalogIdTest;
  if (recentWithCatalogId[0]?.catalog_id !== "799184025")
    throw new Error("Apple library playParams.catalogId was not retained");
  const makeCrowdAlbumItem: any = (
    artist?: any,
    trackName?: any,
    albumName?: any,
  ) => ({
    id: "799184025",
    type: "songs",
    attributes: {
      name: trackName,
      artistName: artist,
      albumArtistName: artist,
      albumName,
      durationInMillis: 287427,
      isrc: "TWAE30800003",
      trackNumber: 3,
    },
    relationships: {
      albums: {
        data: [
          {
            id: "799184005",
            attributes: {
              upc: "4712755010031",
              releaseDate: "2008-05-27",
              trackCount: 12,
            },
          },
        ],
      },
    },
  });
  const nativeLookupKv: any = {
    async get(key?: any) {
      if (key === "apple-user-storefront:v1")
        return {
          id: "cn",
          locale: "zh-Hans-CN",
          checked_at_iso: new Date().toISOString(),
        };
      return null;
    },
    async put() {},
  };
  const fetchBeforeLibraryCatalogFallbackTest: any = globalThis.fetch;
  globalThis.fetch = async (input?: any) => {
    const url: any = String(input);
    if (url.includes("/me/library/songs/library-crowd/catalog"))
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/catalog/cn/songs/799184025"))
      return new Response(
        JSON.stringify({
          data: [makeCrowdAlbumItem("卢广仲", "一百种生活", "一百种生活")],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    if (url.includes("/catalog/tw/songs/799184025"))
      return new Response(
        JSON.stringify({
          data: [makeCrowdAlbumItem("盧廣仲", "一百種生活", "一百種生活")],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    throw new Error(`Unexpected library catalog fallback request: ${url}`);
  };
  const libraryCrowdTrack: any = {
    id: "library-crowd",
    type: "library-songs",
    catalog_id: "799184025",
    artist: "卢广仲",
    album_artist: "卢广仲",
    name: "100种生活",
    album: "100种生活",
    duration_ms: 287427,
  };
  const crowdVariantsFromLibrary: any = await api.getAppleCatalogVariants(
    libraryCrowdTrack,
    "dev-token",
    "user-token",
    nativeLookupKv,
  );
  globalThis.fetch = fetchBeforeLibraryCatalogFallbackTest;
  const preferredCrowdFromLibrary: any = api.choosePreferredAppleTrack(
    libraryCrowdTrack,
    crowdVariantsFromLibrary,
  );
  if (
    crowdVariantsFromLibrary.length !== 2 ||
    preferredCrowdFromLibrary.artist !== "盧廣仲" ||
    preferredCrowdFromLibrary.name !== "一百種生活"
  ) {
    throw new Error(
      "Library-song catalogId fallback did not recover native Taiwan metadata",
    );
  }
  const nativeRegionCases: any = [
    ["TWAE30800003", "tw", "zh-Hant-TW"],
    ["JPP301900001", "jp", "ja-JP"],
    ["KRA401400034", "kr", "ko-KR"],
    ["FRX281900001", "fr", "fr-FR"],
    ["DEUM71900001", "de", "de-DE"],
    ["BRBMG1900001", "br", "pt-BR"],
  ];
  for (const [isrc, storefront, locale] of nativeRegionCases) {
    const region: any = api.preferredAppleRegionForIsrc(isrc);
    if (
      region?.storefront !== storefront ||
      region?.locale !== locale ||
      api.preferredLocaleForIsrc(isrc) !== locale
    ) {
      throw new Error(`ISRC ${isrc} did not select ${storefront}/${locale}`);
    }
  }
  const koreanSource: any = {
    artist: "太阳",
    album_artist: "太阳",
    name: "눈,코,입",
    album: "RISE",
    duration_ms: 229972,
    isrc: "KRA401400034",
    catalog_id: "1695498202",
    _apple_storefront: "cn",
    _apple_album_id: "1695498199",
    _apple_album_upc: "888272005929",
    _apple_release_date: "2014-06-03",
    _apple_album_track_count: 9,
    _apple_track_number: 2,
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
  };
  const koreanNative: any = {
    ...koreanSource,
    artist: "태양",
    album_artist: "태양",
    name: "눈, 코, 입",
    _apple_storefront: "kr",
    _metadata_source: "ko-KR",
    _is_source_storefront: false,
  };
  const koreanEvidence: any = api.appleReleaseEquivalenceEvidence(
    koreanSource,
    koreanNative,
  );
  if (
    !koreanEvidence.exact_apple_catalog_release ||
    koreanEvidence.requires_musicbrainz ||
    api.choosePreferredAppleTrack(koreanSource, [koreanSource, koreanNative])
      .artist !== "태양"
  ) {
    throw new Error(
      "Exact Korean Apple release did not select native metadata",
    );
  }
  const makeKoreanAlbumItem: any = (artist?: any, trackName?: any) => ({
    id: koreanSource.catalog_id,
    type: "songs",
    attributes: {
      name: trackName,
      artistName: artist,
      albumArtistName: artist,
      albumName: "RISE",
      durationInMillis: koreanSource.duration_ms,
      isrc: koreanSource.isrc,
      trackNumber: 2,
    },
    relationships: {
      albums: {
        data: [
          {
            id: koreanSource._apple_album_id,
            attributes: {
              upc: koreanSource._apple_album_upc,
              releaseDate: koreanSource._apple_release_date,
              trackCount: 9,
            },
          },
        ],
      },
    },
  });
  const fetchBeforeKoreanStorefrontTest: any = globalThis.fetch;
  let queriedKoreanStorefront: any = false;
  globalThis.fetch = async (input?: any) => {
    const url: any = String(input);
    if (url.includes("/catalog/cn/songs/1695498202"))
      return new Response(
        JSON.stringify({ data: [makeKoreanAlbumItem("太阳", "눈,코,입")] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    if (url.includes("/catalog/kr/songs/1695498202")) {
      queriedKoreanStorefront = true;
      return new Response(
        JSON.stringify({ data: [makeKoreanAlbumItem("태양", "눈, 코, 입")] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected Korean storefront request: ${url}`);
  };
  const koreanVariants: any = await api.getAppleCatalogVariants(
    { ...koreanSource, id: koreanSource.catalog_id, type: "songs" },
    "dev-token",
    "user-token",
    nativeLookupKv,
  );
  globalThis.fetch = fetchBeforeKoreanStorefrontTest;
  if (
    !queriedKoreanStorefront ||
    api.choosePreferredAppleTrack(koreanSource, koreanVariants).artist !==
      "태양"
  ) {
    throw new Error(
      "Korean ISRC did not query and prefer the Korean Apple storefront",
    );
  }
  const translatedKoreanSource: any = {
    ...koreanSource,
    name: "眼鼻嘴",
    album: "崛起",
    _apple_track_number: 2,
    _apple_album_track_count: 9,
  };
  const koreanRecording: any = {
    id: "a79c4026-7a53-46ac-9e9a-585841f72f60",
    title: "눈, 코, 입",
    length: 230000,
    "artist-credit": [{ name: "태양" }],
  };
  const koreanRelease: any = {
    id: "10a8a3d4-fc1e-4d5f-99d3-7d7c9ba7361b",
    title: "RISE",
    status: "Official",
    date: "2014-06-03",
    country: "KR",
    "release-group": {
      id: "dabe8a9f-4e33-4671-9ad4-13765505f3d9",
      title: "RISE",
      "primary-type": "Album",
      "secondary-types": [],
    },
    media: [
      {
        format: "Digital Media",
        "track-count": 9,
        tracks: [
          {
            title: "눈, 코, 입",
            position: 2,
            length: 230000,
            recording: { id: koreanRecording.id },
          },
        ],
      },
    ],
  };
  const crossLanguageKoreanIdentity: any =
    api.scoreMusicBrainzIdentityCandidate(
      koreanRecording,
      koreanRelease,
      [translatedKoreanSource],
      true,
      true,
    );
  if (!crossLanguageKoreanIdentity)
    throw new Error(
      "Exact-ISRC cross-language MusicBrainz identity was rejected",
    );
  const koreanIdentityAliases: any = api.buildLegalLastFmAliases(
    translatedKoreanSource,
    [translatedKoreanSource],
    {
      confirmed: true,
      recording_mbid: koreanRecording.id,
      release_mbid: koreanRelease.id,
      release_group_mbid: koreanRelease["release-group"].id,
      artist: "태양",
      track: "눈, 코, 입",
      album: "RISE",
      release_group: "RISE",
    },
    null,
  );
  if (
    koreanIdentityAliases[0]?.source !== "musicbrainz_release" ||
    koreanIdentityAliases[0]?.artist !== "태양"
  ) {
    throw new Error(
      "Confirmed native MusicBrainz names were not prioritized over localized Apple names",
    );
  }
  const miyukiSource: any = {
    artist: "中岛美雪",
    album_artist: "中岛美雪",
    name: "银の龙の背に乘って",
    album: "恋文",
    duration_ms: 376093,
    isrc: "JPI800300106",
    _apple_storefront: "cn",
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
    _apple_release_date: "2003-11-19",
    _apple_album_track_count: 10,
    _apple_track_number: 1,
  };
  const miyukiRecording: any = {
    id: "7aa71968-61ed-4b0c-a59f-8472b64dd50d",
    title: "銀の龍の背に乗って",
    length: 376093,
    "artist-credit": [{ name: "中島みゆき" }],
  };
  const miyukiRelease: any = {
    id: "8d008f8c-c6c5-424d-b02a-392b2ca626dc",
    title: "恋文",
    status: "Official",
    date: "2003-11-19",
    country: "JP",
    "release-group": {
      id: "80bd5adf-3aca-3d03-8601-c38a19cf944e",
      title: "恋文",
      "primary-type": "Album",
      "secondary-types": [],
    },
    // MusicBrainz recording lookups can omit track.recording even though this
    // medium entry is the exact recording occurrence returned by the endpoint.
    media: [
      {
        format: "CD",
        "track-count": 10,
        tracks: [{ title: "銀の龍の背に乗って", position: 1, length: 376093 }],
      },
    ],
  };
  const miyukiCandidate: any = api.scoreMusicBrainzIdentityCandidate(
    miyukiRecording,
    miyukiRelease,
    [miyukiSource],
    true,
    true,
  );
  if (
    !miyukiCandidate?.trackEvidence?.associated ||
    !miyukiCandidate.trackEvidence.track_number_match ||
    !miyukiCandidate.trackEvidence.track_count_match
  ) {
    throw new Error(
      "Exact-ISRC Japanese release occurrence was rejected after Apple title localization",
    );
  }
  const miyukiWrongPosition: any = {
    ...miyukiRelease,
    media: [
      {
        format: "CD",
        "track-count": 10,
        tracks: [{ title: "銀の龍の背に乗って", position: 2, length: 376093 }],
      },
    ],
  };
  if (
    api.scoreMusicBrainzIdentityCandidate(
      miyukiRecording,
      miyukiWrongPosition,
      [miyukiSource],
      true,
      true,
    )
  ) {
    throw new Error(
      "Cross-script exact-ISRC release evidence accepted the wrong track position",
    );
  }
  const miyukiIdentity: any = {
    confirmed: true,
    method: "isrc",
    recording_mbid: miyukiRecording.id,
    release_mbid: miyukiRelease.id,
    release_group_mbid: miyukiRelease["release-group"].id,
    artist: "中島みゆき",
    track: "銀の龍の背に乗って",
    album: "恋文",
    release_group: "恋文",
    release_group_release_mbids: [miyukiRelease.id],
  };
  const fetchBeforeMiyukiMappingTest: any = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        album: {
          name: "恋文",
          artist: "中島みゆき",
          mbid: miyukiRelease.id,
          image: [{ "#text": "https://lastfm.example/koibumi.jpg" }],
          tracks: { track: [{ name: "銀の龍の背に乗って", duration: 376 }] },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const miyukiMapped: any = await api.mapConfirmedIdentityToLastFm(
    miyukiSource,
    [miyukiSource],
    miyukiIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = fetchBeforeMiyukiMappingTest;
  if (
    miyukiMapped.artist !== "中島みゆき" ||
    miyukiMapped.name !== "銀の龍の背に乗って" ||
    miyukiMapped.album !== "恋文" ||
    miyukiMapped.mbid !== miyukiRecording.id ||
    !miyukiMapped._lastfm_artwork_match
  ) {
    throw new Error(
      "Confirmed Japanese MusicBrainz release did not map to the native Last.fm artwork entry",
    );
  }
  const jjSource: any = {
    id: "1694849138",
    type: "songs",
    catalog_id: "1694849138",
    artist: "林俊杰",
    album_artist: "林俊杰",
    name: "修炼爱情",
    album: "因你 而在",
    duration_ms: 287000,
    isrc: "TWA531398004",
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
  };
  const jjNative: any = {
    ...jjSource,
    artist: "林俊傑",
    album_artist: "林俊傑",
    name: "修煉愛情",
    _metadata_source: "zh-Hant-TW",
    _is_source_storefront: false,
    _apple_release_equivalence_method: "exact_apple_catalog_release",
  };
  const jjIdentity: any = {
    confirmed: true,
    recording_mbid: "44bc226c-a018-4d1f-88d7-c8eff0bec18e",
    release_mbid: "cc2b47ff-e1c6-4c7d-8de6-1e1560bf5492",
    release_group_mbid: "ba8cde9b-466c-45f2-a3a9-701a08ea4b04",
    artist: "林俊杰",
    track: "修炼爱情",
    album: "因你 而在",
    release_group: "因你 而在 (Stories Untold)",
  };
  const jjAliases: any = api.buildLegalLastFmAliases(
    jjNative,
    [jjSource, jjNative],
    jjIdentity,
    null,
  );
  if (
    jjAliases[0]?.source !== "apple_preferred" ||
    jjAliases[0]?.artist !== "林俊傑" ||
    jjAliases[0]?.track !== "修煉愛情"
  ) {
    throw new Error(
      "Confirmed native Apple metadata was overwritten by a localized MusicBrainz release title",
    );
  }
  const fetchBeforeJjMappingTest: any = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        album: {
          name: "因你 而在",
          artist: "林俊傑",
          mbid: jjIdentity.release_mbid,
          image: [{ "#text": "https://lastfm.example/stories-untold.jpg" }],
          tracks: { track: [{ name: "修炼爱情", duration: 287 }] },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const jjMapped: any = await api.mapConfirmedIdentityToLastFm(
    jjNative,
    [jjSource, jjNative],
    jjIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = fetchBeforeJjMappingTest;
  if (
    jjMapped.artist !== "林俊傑" ||
    jjMapped.name !== "修煉愛情" ||
    jjMapped.album !== "因你 而在" ||
    jjMapped.mbid !== jjIdentity.recording_mbid ||
    !jjMapped._lastfm_artwork_match
  ) {
    throw new Error(
      "Last.fm artwork mapping overwrote confirmed native Apple metadata",
    );
  }
  const engravedSource: any = {
    id: "1601843206",
    artist: "卢广仲",
    album_artist: "卢广仲",
    name: "刻在我心底的名字",
    album: "刻在我心底的名字",
    duration_ms: 320166,
    isrc: "TWCG52193897",
    catalog_id: "1601843206",
    _apple_storefront: "cn",
    _apple_album_id: "1601843205",
    _apple_release_date: "2020-08-25",
    _apple_album_track_count: 1,
    _apple_track_number: 1,
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
  };
  const engravedNative: any = {
    ...engravedSource,
    id: "1528149435",
    artist: "盧廣仲",
    album_artist: "盧廣仲",
    name: "刻在我心底的名字 (電影《刻在你心底的名字》主題曲)",
    album: "刻在我心底的名字 (電影《刻在你心底的名字》主題曲)",
    catalog_id: "1528149435",
    isrc: "TWK012000002",
    _apple_storefront: "tw",
    _apple_album_id: "1528149434",
    _metadata_source: "zh-Hant-TW",
    _is_source_storefront: false,
    _apple_lookup_method: "native_catalog_search",
    _apple_release_equivalence_requires_musicbrainz: true,
  };
  const engravedAppleEvidence: any = api.appleReleaseEquivalenceEvidence(
    engravedSource,
    engravedNative,
  );
  if (
    !engravedAppleEvidence.matches ||
    !engravedAppleEvidence.requires_musicbrainz
  ) {
    throw new Error(
      "Guarded native Apple search did not retain an equivalent single with a territory-specific ISRC",
    );
  }
  const makeEngravedAppleItem: any = (native: any = false) => ({
    id: native ? engravedNative.id : engravedSource.id,
    type: "songs",
    attributes: {
      name: native ? engravedNative.name : engravedSource.name,
      artistName: native ? engravedNative.artist : engravedSource.artist,
      albumArtistName: native
        ? engravedNative.album_artist
        : engravedSource.album_artist,
      albumName: `${native ? engravedNative.album : engravedSource.album} - Single`,
      durationInMillis: engravedSource.duration_ms,
      isrc: native ? engravedNative.isrc : engravedSource.isrc,
      trackNumber: 1,
      isCompilation: false,
    },
    relationships: {
      albums: {
        data: [
          {
            id: native
              ? engravedNative._apple_album_id
              : engravedSource._apple_album_id,
            attributes: {
              upc: native ? "4711228312467" : "4711281406011",
              releaseDate: "2020-08-25",
              trackCount: 1,
            },
          },
        ],
      },
    },
  });
  const fetchBeforeNativeSearchTest: any = globalThis.fetch;
  let queriedNativeSearch: any = false;
  globalThis.fetch = async (input?: any) => {
    const url: any = String(input);
    if (url.includes("/catalog/cn/songs/1601843206"))
      return new Response(
        JSON.stringify({ data: [makeEngravedAppleItem(false)] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    if (url.includes("/catalog/tw/songs/1601843206"))
      return new Response(JSON.stringify({ data: [] }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/catalog/tw/songs?filter[isrc]="))
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/catalog/tw/search?")) {
      queriedNativeSearch = true;
      return new Response(
        JSON.stringify({
          results: { songs: { data: [makeEngravedAppleItem(true)] } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected native Apple search request: ${url}`);
  };
  const engravedSearchVariants: any = await api.getAppleCatalogVariants(
    { ...engravedSource, type: "songs" },
    "dev-token",
    "user-token",
    nativeLookupKv,
  );
  globalThis.fetch = fetchBeforeNativeSearchTest;
  const engravedSearchPreferred: any = api.choosePreferredAppleTrack(
    engravedSource,
    engravedSearchVariants,
  );
  if (
    !queriedNativeSearch ||
    engravedSearchVariants.length !== 2 ||
    engravedSearchPreferred.artist !== "盧廣仲" ||
    engravedSearchPreferred._apple_lookup_method !== "native_catalog_search"
  ) {
    throw new Error(
      "Apple native catalog search fallback did not recover the guarded Taiwan single",
    );
  }
  const incompleteNativeCacheWrites: any = [];
  const incompleteNativeKv: any = {
    async get() {
      return null;
    },
    async put(key?: any, value?: any) {
      incompleteNativeCacheWrites.push({ key, value });
    },
  };
  const fetchBeforeIncompleteNativeCacheTest: any = globalThis.fetch;
  globalThis.fetch = async (input?: any) => {
    const url: any = String(input);
    if (url.includes("/isrc/"))
      return new Response(JSON.stringify({ recordings: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/recording/?"))
      return new Response(JSON.stringify({ recordings: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/artist/?"))
      return new Response(JSON.stringify({ artists: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    throw new Error(`Unexpected incomplete-native MusicBrainz request: ${url}`);
  };
  const incompleteNativeIdentity: any = await api.resolveMusicBrainzIdentity(
    engravedSource,
    [engravedSource],
    incompleteNativeKv,
  );
  globalThis.fetch = fetchBeforeIncompleteNativeCacheTest;
  if (incompleteNativeIdentity || incompleteNativeCacheWrites.length > 0) {
    throw new Error(
      "Missing native Apple metadata incorrectly persisted a negative MusicBrainz identity cache",
    );
  }
  const engravedRecording: any = {
    id: "d2c27f2f-b3ef-49ce-af89-762c4ee26100",
    title: "刻在我心底的名字",
    length: 320000,
    "artist-credit": [{ name: "盧廣仲" }],
  };
  const engravedRelease: any = {
    id: "b7d085da-c759-41cb-ac1d-8b0fa1d781e3",
    title: "刻在我心底的名字 (電影《刻在你心底的名字》主題曲)",
    status: "Official",
    date: "2020-08-25",
    country: "TW",
    "release-group": {
      id: "26116d92-934c-4135-b7ab-f3141e3cdcda",
      title: "刻在我心底的名字 (電影《刻在你心底的名字》主題曲)",
      "primary-type": "Single",
      "secondary-types": ["Soundtrack"],
    },
    media: [
      {
        format: "Digital Media",
        "track-count": 1,
        tracks: [{ title: "刻在我心底的名字", position: 1, length: 320000 }],
      },
    ],
  };
  const engravedIdentityCandidate: any = api.scoreMusicBrainzIdentityCandidate(
    engravedRecording,
    engravedRelease,
    [engravedSource, engravedNative],
    false,
    true,
  );
  if (!engravedIdentityCandidate)
    throw new Error(
      "MusicBrainz did not confirm the native official engraved-name single",
    );
  const engravedIdentity: any = {
    release_group_mbid: engravedRelease["release-group"].id,
    album: engravedRelease.title,
    release_group: engravedRelease["release-group"].title,
  };
  const engravedConfirmedVariants: any =
    api.filterMusicBrainzConfirmedAppleVariants(
      [engravedSource, engravedNative],
      engravedIdentity,
    );
  if (
    engravedConfirmedVariants.length !== 2 ||
    api.choosePreferredAppleTrack(engravedSource, engravedConfirmedVariants)
      .artist !== "盧廣仲"
  ) {
    throw new Error(
      "MusicBrainz-confirmed native engraved-name release was not retained",
    );
  }
  const crowdSource: any = {
    id: "1601582674",
    type: "songs",
    artist: "卢广仲",
    album_artist: "卢广仲",
    name: "大人中",
    album: "大人中",
    _apple_raw_album: "大人中 - Single",
    duration_ms: 282173,
    isrc: "TWK011400001",
    _apple_storefront: "cn",
    _apple_album_id: "1601582672",
    _apple_album_upc: "4711281407650",
    _apple_release_date: "2014-03-13",
    _apple_album_track_count: 2,
    _apple_track_number: 2,
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
  };
  const oneHundredSource: any = {
    ...crowdSource,
    name: "100种生活",
    album: "100种生活",
    duration_ms: 287427,
    isrc: "TWK010800003",
    _apple_release_date: "2008-05-27",
    _apple_album_track_count: 12,
    _apple_track_number: 5,
  };
  const oneHundredNative: any = {
    ...oneHundredSource,
    artist: "盧廣仲",
    album_artist: "盧廣仲",
    name: "一百種生活",
    album: "一百種生活",
    _apple_storefront: "tw",
    _metadata_source: "zh-Hant-TW",
    _is_source_storefront: false,
    _apple_track_number: 3,
  };
  const oneHundredEvidence: any = api.appleReleaseEquivalenceEvidence(
    oneHundredSource,
    oneHundredNative,
  );
  if (
    !oneHundredEvidence.matches ||
    !oneHundredEvidence.requires_musicbrainz ||
    !oneHundredEvidence.regional_track_order_variance
  ) {
    throw new Error(
      "Exact-ISRC same-date regional track-order variance was not retained for MusicBrainz confirmation",
    );
  }
  const crowdNative: any = {
    ...crowdSource,
    id: "859721708",
    artist: "盧廣仲",
    album_artist: "盧廣仲",
    duration_ms: 280167,
    _apple_storefront: "tw",
    _apple_album_id: "859721607",
    _apple_album_upc: "4712818789195",
    _apple_release_date: "2014-03-29",
    _apple_track_number: 1,
    _metadata_source: "zh-Hant-TW",
    _is_source_storefront: false,
  };
  const crowdEvidence: any = api.appleReleaseEquivalenceEvidence(
    crowdSource,
    crowdNative,
  );
  if (crowdEvidence.matches || !crowdEvidence.requires_album_isrc_set)
    throw new Error(
      "Reordered regional single did not require a full-album ISRC comparison",
    );
  if (
    !api.appleAlbumIsrcSignaturesMatch(
      ["TWK011400002", "TWK011400001"],
      ["TWK011400001", "TWK011400002"],
      2,
    )
  )
    throw new Error("Equivalent reordered album ISRC sets were rejected");
  if (
    api.appleAlbumIsrcSignaturesMatch(
      ["TWK011400002", "TWK011400001"],
      ["TWK011400001", "DIFFERENT"],
      2,
    )
  )
    throw new Error("Different album ISRC sets were accepted");
  const crowdNativeItem: any = {
    id: crowdNative.id,
    type: "songs",
    _storefront: "tw",
    attributes: {
      name: crowdNative.name,
      artistName: crowdNative.artist,
      albumArtistName: crowdNative.album_artist,
      albumName: crowdNative._apple_raw_album,
      durationInMillis: crowdNative.duration_ms,
      isrc: crowdNative.isrc,
      trackNumber: crowdNative._apple_track_number,
    },
    relationships: {
      albums: {
        data: [
          {
            id: crowdNative._apple_album_id,
            attributes: {
              upc: crowdNative._apple_album_upc,
              releaseDate: crowdNative._apple_release_date,
              trackCount: 2,
            },
          },
        ],
      },
    },
  };
  const fetchBeforeAlbumSetTest: any = globalThis.fetch;
  globalThis.fetch = async (input?: any) => {
    const url: any = String(input);
    const isTaiwan: any = url.includes("/catalog/tw/albums/859721607/tracks");
    const isChina: any = url.includes("/catalog/cn/albums/1601582672/tracks");
    if (!isTaiwan && !isChina)
      throw new Error(`Unexpected album ISRC request: ${url}`);
    const isrcs: any = isTaiwan
      ? ["TWK011400001", "TWK011400002"]
      : ["TWK011400002", "TWK011400001"];
    return new Response(
      JSON.stringify({
        data: isrcs.map((isrc?: any) => ({ attributes: { isrc } })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const crowdSelected: any = await api.chooseAppleCatalogItem(
    [crowdNativeItem],
    crowdSource,
    crowdSource,
    "dev-token",
    "user-token",
  );
  globalThis.fetch = fetchBeforeAlbumSetTest;
  if (
    crowdSelected?.artist !== "盧廣仲" ||
    crowdSelected?._apple_release_equivalence_method !==
      "exact_album_isrc_set" ||
    crowdSelected?._apple_release_equivalence_requires_musicbrainz
  ) {
    throw new Error(
      "Full-album ISRC evidence did not confirm the reordered native release",
    );
  }
  const jayApple: any = [
    {
      artist: "周杰倫",
      album_artist: "周杰倫",
      name: "暗號 (Live)",
      album: "The One 周杰倫演唱會",
      duration_ms: 287387,
      isrc: "TWK970204004",
      _is_source_storefront: true,
      _apple_release_date: "2002-10-25",
      _apple_track_number: 4,
    },
  ];
  const jayRecording: any = {
    id: "b97bd9f4-0bbc-47f0-a980-68f8512ef131",
    title: "暗號",
    length: 287000,
    disambiguation: "live, 2002: The One",
    "artist-credit": [{ name: "周杰倫" }],
  };
  const theOneRelease: any = {
    id: "09f83143-55b7-4506-a16e-c8705bbb7023",
    title: "The One",
    status: "Official",
    date: "2002-10-25",
    country: "TW",
    "release-group": {
      id: "eae7f8b6-b73b-3c39-98d2-4938168181cd",
      title: "The One",
      "primary-type": "Album",
      "secondary-types": ["Live"],
    },
    media: [
      {
        "track-count": 11,
        tracks: [{ title: "暗號", position: 4, length: 287000 }],
      },
    ],
  };
  if (
    !api.scoreMusicBrainzIdentityCandidate(
      jayRecording,
      theOneRelease,
      jayApple,
      true,
    )
  )
    throw new Error("The One MusicBrainz identity was rejected");
  if (
    api.scoreMusicBrainzIdentityCandidate(
      jayRecording,
      {
        ...theOneRelease,
        title: "八度空間",
        "release-group": {
          ...theOneRelease["release-group"],
          title: "八度空間",
          "secondary-types": [],
        },
      },
      jayApple,
      true,
    )
  )
    throw new Error("Studio/wrong-album release was accepted");
  const sunApple: any = [
    {
      artist: "孫燕姿",
      album_artist: "孫燕姿",
      name: "我也很想他",
      album: "孫燕姿Stefanie同名專輯",
      duration_ms: 257200,
      _is_source_storefront: true,
    },
  ];
  const sunRecording: any = {
    id: "recording-sun",
    title: "我也很想他",
    length: 257200,
    "artist-credit": [{ name: "孫燕姿" }],
  };
  const wrongCompilation: any = {
    id: "wrong-release",
    title: "My Story, Your Song",
    status: "Official",
    "release-group": {
      id: "wrong-rg",
      title: "My Story, Your Song",
      "primary-type": "Album",
      "secondary-types": ["Compilation"],
    },
  };
  if (
    api.scoreMusicBrainzIdentityCandidate(
      sunRecording,
      wrongCompilation,
      sunApple,
      false,
    )
  )
    throw new Error("Sun Yanzi compilation was accepted");
  const fujiiSource: any = {
    artist: "Fujii Kaze",
    name: "Nan-Nan",
    album: "HELP EVER HURT NEVER",
    isrc: "JPPO02000179",
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
  };
  const fujiiNative: any = {
    ...fujiiSource,
    artist: "藤井 風",
    name: "何なんw",
    _metadata_source: "ja-JP",
    _is_source_storefront: false,
  };
  if (
    api.choosePreferredAppleTrack(fujiiSource, [fujiiSource, fujiiNative])
      .name !== "何なんw"
  )
    throw new Error("Japanese native metadata was not preferred");
  const fujiiDisplayFromChinese: any = api.applyArtistDisplayOverride({
    artist: "藤井风",
    album_artist: "藤井风",
  });
  const fujiiDisplayFromJapanese: any = api.applyArtistDisplayOverride({
    artist: "藤井風",
    album_artist: "藤井風",
  });
  const fujiiDisplayFromEnglish: any = api.applyArtistDisplayOverride({
    artist: "Fujii Kaze",
    album_artist: "Fujii Kaze",
  });
  if (
    [
      fujiiDisplayFromChinese,
      fujiiDisplayFromJapanese,
      fujiiDisplayFromEnglish,
    ].some(
      (track?: any) =>
        track.artist !== "藤井 風" || track.album_artist !== "藤井 風",
    )
  ) {
    throw new Error(
      "Fujii Kaze display override did not unify all trusted aliases",
    );
  }
  const fujiiCompilationDisplay: any = api.applyArtistDisplayOverride(
    { artist: "藤井風", album_artist: "Various Artists" },
    { artist_mbid: "c3a4aeca-8f02-4d22-b1ff-693434ab09a8", artist: "藤井風" },
  );
  if (
    fujiiCompilationDisplay.artist !== "藤井 風" ||
    fujiiCompilationDisplay.album_artist !== "Various Artists"
  ) {
    throw new Error(
      "Fujii Kaze display override changed a compilation album artist",
    );
  }
  const kiroroSource: any = {
    id: "156209828",
    type: "songs",
    catalog_id: "156209828",
    artist: "KIRORO",
    album_artist: "KIRORO",
    name: "Mirai E [Remastered]",
    album: "Kiroro No Ichiban Ii Uta Atsumemashita",
    duration_ms: 329587,
    isrc: "JPVI09806960",
    _apple_storefront: "cn",
    _apple_album_id: "156209576",
    _apple_album_upc: "4988002499557",
    _apple_release_date: "2006-03-29",
    _apple_album_track_count: 17,
    _apple_track_number: 2,
    _apple_is_compilation: true,
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
  };
  const kiroroNative: any = {
    ...kiroroSource,
    artist: "Kiroro",
    album_artist: "Kiroro",
    name: "未来へ",
    album: "キロロのいちばんイイ歌あつめました",
    _apple_storefront: "jp",
    _metadata_source: "ja-JP",
    _is_source_storefront: false,
    _apple_release_equivalence_method: "exact_apple_catalog_release",
  };
  const kiroroEvidence: any = api.appleReleaseEquivalenceEvidence(
    kiroroSource,
    kiroroNative,
  );
  if (
    !kiroroEvidence.matches ||
    !kiroroEvidence.exact_apple_catalog_release ||
    kiroroEvidence.requires_musicbrainz
  ) {
    throw new Error(
      "Exact Apple catalog identity did not authorize native Japanese metadata",
    );
  }
  if (
    api.choosePreferredAppleTrack(kiroroSource, [kiroroSource, kiroroNative])
      .name !== "未来へ"
  ) {
    throw new Error("Exact Japanese Apple catalog metadata was not preferred");
  }
  if (
    api.appleReleaseEquivalenceEvidence(kiroroSource, {
      ...kiroroNative,
      _apple_album_id: "different",
    }).matches
  ) {
    throw new Error(
      "Version-different Apple metadata was trusted without exact catalog release identity",
    );
  }
  const kiroroMapped: any = api.appleCatalogItemToTrack(
    {
      id: "156209828",
      attributes: {
        name: "未来へ",
        artistName: "Kiroro",
        albumArtistName: "Kiroro",
        albumName: "キロロのいちばんイイ歌あつめました",
        durationInMillis: 329587,
        isrc: "JPVI09806960",
        trackNumber: 2,
      },
      relationships: {
        albums: {
          data: [
            {
              id: "156209576",
              attributes: {
                upc: "4988002499557",
                releaseDate: "2006-03-29",
                trackCount: 17,
                isCompilation: true,
              },
            },
          ],
        },
      },
    },
    kiroroSource,
    "jp",
  );
  if (!kiroroMapped?._apple_is_compilation)
    throw new Error("Apple album-level compilation metadata was lost");
  const kiroroRecording: any = {
    id: "e37bc4c0-8b5b-4699-bd1c-8f742df828db",
    title: "未来へ",
    length: 329973,
    "artist-credit": [{ name: "Kiroro" }],
  };
  const kiroroRelease: any = {
    id: "059de315-89b2-468a-9f61-5c0b4ca5e0c8",
    title: "キロロのいちばんイイ歌あつめました",
    status: "Official",
    date: "2006-03-29",
    country: "JP",
    barcode: "4988002499557",
    "release-group": {
      id: "0651cf9f-fb8b-3f16-bbe9-18c6da8f9d06",
      title: "キロロのいちばんイイ歌あつめました",
      "primary-type": "Album",
      "secondary-types": ["Compilation"],
    },
    media: [
      {
        format: "Digital Media",
        "track-count": 17,
        tracks: [{ title: "未来へ", position: 2, length: 329973 }],
      },
    ],
  };
  if (
    !api.scoreMusicBrainzIdentityCandidate(
      kiroroRecording,
      kiroroRelease,
      [kiroroSource, kiroroNative],
      true,
      true,
    )
  ) {
    throw new Error(
      "Exact native Apple metadata did not confirm the Kiroro MusicBrainz compilation release",
    );
  }
  const recordingMbid: any = api.buildLastFmPayload({
    track: {
      artist: "A",
      name: "T",
      album: "R",
      mbid: "recording-id",
      mbid_kind: "recording",
    },
    timestamp: new Date(),
  });
  const releaseMbid: any = api.buildLastFmPayload({
    track: {
      artist: "A",
      name: "T",
      album: "R",
      mbid: "release-id",
      mbid_kind: "release",
    },
    timestamp: new Date(),
  });
  if (recordingMbid.mbid !== "recording-id" || releaseMbid.mbid !== "")
    throw new Error("Last.fm MBID parameter is not recording-only");
  const realFetch: any = globalThis.fetch;
  const queriedAlbums: any = [];
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    const method: any = url.searchParams.get("method");
    if (method === "album.getInfo") {
      const album: any = url.searchParams.get("album");
      queriedAlbums.push(album);
      if (album === "The One 周杰倫演唱會") {
        return new Response(
          JSON.stringify({
            album: {
              name: album,
              artist: "周杰倫",
              image: [{ "#text": "https://lastfm.example/the-one.jpg" }],
              tracks: { track: [{ name: "暗號 (Live)", duration: 287 }] },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (album === "八度空間") {
        return new Response(
          JSON.stringify({
            album: {
              name: album,
              artist: "周杰倫",
              image: [{ "#text": "https://lastfm.example/wrong.jpg" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: 6 }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const mapped: any = await api.mapConfirmedIdentityToLastFm(
    jayApple[0],
    jayApple,
    {
      confirmed: true,
      method: "isrc",
      recording_mbid: jayRecording.id,
      release_mbid: theOneRelease.id,
      release_group_mbid: theOneRelease["release-group"].id,
      artist: "周杰倫",
      track: "暗號",
      album: "The One",
      release_group: "The One",
    },
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    mapped.album !== "The One 周杰倫演唱會" ||
    mapped.mbid !== jayRecording.id ||
    mapped.mbid_kind !== "recording"
  )
    throw new Error("Confirmed Last.fm mapping failed");
  if (queriedAlbums.includes("八度空間"))
    throw new Error("An unproven Last.fm release alias was queried");
  const qinghuaApple: any = [
    {
      artist: "周杰倫",
      album_artist: "周杰倫",
      name: "青花瓷 (Live)",
      album: "魔天倫世界巡迴演唱會 (Live)",
      duration_ms: 238387,
      _apple_album_track_count: 22,
    },
    {
      artist: "周杰伦",
      album_artist: "周杰伦",
      name: "青花瓷 (Live)",
      album: "魔天伦世界巡回演唱会 (Live)",
      duration_ms: 238387,
      _apple_album_track_count: 22,
    },
  ];
  const qinghuaIdentity: any = {
    confirmed: true,
    method: "strict_search",
    recording_mbid: "4b22d6c6-17cc-4d7f-8c23-3aa66ddf8c9e",
    release_mbid: "85bfe368-5385-4f25-9cec-c759d406e78e",
    release_group_mbid: "befa5360-1b49-43b7-8d82-fb9ec20a3803",
    artist: "周杰倫",
    track: "青花瓷",
    album: "魔天伦世界巡回演唱会",
    release_group: "魔天伦世界巡回演唱会",
    version_attributes: {
      live: true,
      remaster: false,
      acoustic: false,
      instrumental: false,
      remix: false,
    },
  };
  const qinghuaAliases: any = api.buildLegalLastFmAliases(
    qinghuaApple[0],
    qinghuaApple,
    qinghuaIdentity,
    null,
  );
  if (
    !qinghuaAliases.some(
      (candidate?: any) =>
        candidate.album === "魔天倫世界巡迴演唱會" &&
        candidate.track === "青花瓷 (Live)" &&
        candidate.source === "musicbrainz_confirmed_live_album_alias",
    )
  ) {
    throw new Error(
      "Confirmed native-script live album alias was not generated",
    );
  }
  const unconfirmedAliases: any = api.buildLegalLastFmAliases(
    qinghuaApple[0],
    qinghuaApple,
    { ...qinghuaIdentity, release_mbid: null },
    null,
  );
  if (
    unconfirmedAliases.some(
      (candidate?: any) =>
        candidate.source === "musicbrainz_confirmed_live_album_alias",
    )
  ) {
    throw new Error(
      "Live suffix alias was generated without a confirmed MusicBrainz release",
    );
  }
  const migratedCacheWrites: any = [];
  const legacyCache: any = {
    async get(key?: any) {
      if (key.includes("musicbrainz-identity:v4:")) {
        const { version_attributes, ...legacyIdentity }: any = qinghuaIdentity;
        return {
          identity: legacyIdentity,
          checked_at_iso: new Date().toISOString(),
        };
      }
      return null;
    },
    async put(key?: any, value?: any) {
      migratedCacheWrites.push({ key, value });
    },
  };
  const migratedIdentity: any = await api.resolveMusicBrainzIdentity(
    qinghuaApple[0],
    qinghuaApple,
    legacyCache,
  );
  if (
    !migratedIdentity?.version_attributes?.live ||
    !migratedCacheWrites.some(({ key }: any) =>
      key.includes("musicbrainz-identity:v16:"),
    )
  ) {
    throw new Error(
      "Positive MusicBrainz identity cache was not safely migrated",
    );
  }
  const snailApple: any = [
    {
      artist: "周杰伦",
      album_artist: "周杰伦",
      name: "蜗牛 (Live)",
      album: "范特西 (Live)",
      duration_ms: 238893,
      isrc: "TWK970100401",
      _is_source_storefront: true,
      _apple_release_date: "2001-12-31",
      _apple_album_track_count: 3,
      _apple_track_number: 1,
    },
    {
      artist: "周杰倫",
      album_artist: "周杰倫",
      name: "蝸牛 (Live)",
      album: "范特西 (Live)",
      duration_ms: 238893,
      isrc: "TWK970100401",
      _is_source_storefront: false,
      _apple_release_date: "2001-12-31",
      _apple_album_track_count: 3,
      _apple_track_number: 1,
    },
  ];
  const snailRecording: any = {
    id: "5723e991-1ab5-423c-bd1f-d7c1addd467a",
    title: "蜗牛",
    length: 238893,
    disambiguation: "live",
    "artist-credit": [{ name: "周杰倫" }],
    releases: [
      {
        id: "29d1ff9a-8d50-406e-b2f7-ff2ec83d8bc3",
        title: "Fantasy Plus",
        status: "Official",
        date: "2001-12-24",
        country: "TW",
        barcode: "",
        "release-group": {
          id: "c91314f2-5b6c-39b6-8fd2-74fbc4ad2477",
          title: "Fantasy Plus",
          "primary-type": "EP",
          "secondary-types": ["Live"],
        },
        media: [
          {
            format: "Digital Media",
            "track-count": 3,
            tracks: [{ title: "蜗牛", position: 1, length: 238893 }],
          },
        ],
      },
      {
        id: "2645f6b3-6f12-4dc1-9ad3-0d86709d425a",
        title: "Fantasy Plus",
        status: "Official",
        date: "2001-12",
        country: "TW",
        barcode: "743219150424",
        "release-group": {
          id: "c91314f2-5b6c-39b6-8fd2-74fbc4ad2477",
          title: "Fantasy Plus",
          "primary-type": "EP",
          "secondary-types": ["Live"],
        },
        media: [
          {
            format: "CD",
            "track-count": 3,
            tracks: [{ title: "蝸牛", position: 1, length: 238893 }],
          },
        ],
      },
    ],
  };
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    if (url.pathname.includes("/isrc/")) {
      return new Response(
        JSON.stringify({
          recordings: [
            {
              id: snailRecording.id,
              title: snailRecording.title,
              length: snailRecording.length,
              disambiguation: snailRecording.disambiguation,
              "artist-credit": snailRecording["artist-credit"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname.includes(`/recording/${snailRecording.id}`)) {
      return new Response(JSON.stringify(snailRecording), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected MusicBrainz fetch: ${url}`);
  };
  const noCache: any = {
    async get() {
      return null;
    },
    async put() {},
  };
  const snailIdentity: any = await api.resolveMusicBrainzIdentity(
    snailApple[1],
    snailApple,
    noCache,
  );
  globalThis.fetch = realFetch;
  if (
    snailIdentity?.recording_mbid !== snailRecording.id ||
    snailIdentity.release_mbid !== "29d1ff9a-8d50-406e-b2f7-ff2ec83d8bc3" ||
    snailIdentity.release_group_mbid !==
      "c91314f2-5b6c-39b6-8fd2-74fbc4ad2477" ||
    !snailIdentity.release_group_release_mbids?.includes(
      "2645f6b3-6f12-4dc1-9ad3-0d86709d425a",
    ) ||
    snailIdentity.release_equivalence_method !== "isrc_medium_release_group" ||
    !snailIdentity.version_attributes?.live
  ) {
    throw new Error(
      "Exact-ISRC Fantasy Plus release-group identity was not confirmed",
    );
  }
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    const album: any = url.searchParams.get("album");
    if (album === "Fantasy Plus") {
      return new Response(
        JSON.stringify({
          album: {
            name: "Fantasy Plus",
            artist: "周杰倫",
            mbid: "2645f6b3-6f12-4dc1-9ad3-0d86709d425a",
            image: [{ "#text": "https://lastfm.example/fantasy-plus.jpg" }],
            tracks: {
              track: [
                { name: "蝸牛", duration: 238 },
                { name: "你比從前快樂", duration: 202 },
                { name: "世界末日", duration: 265 },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        album: {
          name: album,
          artist: "周杰倫",
          image: [
            {
              "#text":
                "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const snailMapped: any = await api.mapConfirmedIdentityToLastFm(
    snailApple[1],
    snailApple,
    snailIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    snailMapped.artist !== "周杰倫" ||
    snailMapped.name !== "蝸牛" ||
    snailMapped.album !== "Fantasy Plus" ||
    snailMapped.mbid !== snailRecording.id ||
    !snailMapped._lastfm_artwork_match
  ) {
    throw new Error("Fantasy Plus Last.fm release-group mapping failed");
  }
  let spotifySearches: any = 0;
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    if (url.hostname === "accounts.spotify.com") {
      return new Response(
        JSON.stringify({
          access_token: "spotify-test-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.hostname === "api.spotify.com") {
      spotifySearches += 1;
      return new Response(
        JSON.stringify({
          tracks: {
            items: [
              {
                external_ids: { isrc: "TWK970100401" },
                duration_ms: 238893,
                name: "蜗牛 (Live)",
                artists: [{ name: "周杰伦" }],
                track_number: 1,
                album: {
                  name: "范特西 (Live) - Single",
                  album_type: "single",
                  release_date: "2001-12-31",
                  total_tracks: 3,
                },
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected Spotify fetch: ${url}`);
  };
  const snailReleaseGapIdentity: any = {
    ...snailIdentity,
    release_mbid: null,
    release_group_mbid: null,
    album: null,
    release_group: null,
  };
  const spotifyEvidence: any = await api.getConditionalSpotifyEvidence(
    snailApple[0],
    snailApple,
    snailReleaseGapIdentity,
    { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" },
  );
  const spotifySkipped: any = await api.getConditionalSpotifyEvidence(
    snailApple[0],
    snailApple,
    { ...snailIdentity, release_mbid: "confirmed-release" },
    { SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" },
  );
  globalThis.fetch = realFetch;
  if (!spotifyEvidence || spotifySearches !== 1 || spotifySkipped !== null) {
    throw new Error("Spotify release-gap trigger did not behave conditionally");
  }
  const qinghuaQueries: any = [];
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    const album: any = url.searchParams.get("album");
    qinghuaQueries.push(album);
    if (album === "魔天倫世界巡迴演唱會") {
      return new Response(
        JSON.stringify({
          album: {
            name: album,
            artist: "周杰倫",
            image: [{ "#text": "https://lastfm.example/opus-jay.jpg" }],
            tracks: {
              track: Array.from({ length: 22 }, (_?: any, index?: any) => ({
                name: index === 15 ? "青花瓷 (Live)" : `Track ${index + 1}`,
                duration: index === 15 ? 238 : 180,
              })),
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        album: {
          name: album,
          artist: "周杰倫",
          image: [
            {
              "#text":
                "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const qinghuaMapped: any = await api.mapConfirmedIdentityToLastFm(
    qinghuaApple[0],
    qinghuaApple,
    qinghuaIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    qinghuaMapped.album !== "魔天倫世界巡迴演唱會" ||
    qinghuaMapped.name !== "青花瓷 (Live)" ||
    !qinghuaMapped._lastfm_artwork_match
  ) {
    throw new Error("Confirmed Qing Hua Ci live artwork alias mapping failed");
  }
  if (!qinghuaQueries.includes("魔天倫世界巡迴演唱會"))
    throw new Error("Confirmed live album alias was not queried");
  const maydayApple: any = [
    {
      artist: "五月天",
      album_artist: "五月天",
      name: "溫柔 #MaydayBlue20th (feat.孫燕姿)",
      album: "溫柔 #MaydayBlue20th (feat.孫燕姿)",
      _apple_raw_album: "溫柔 #MaydayBlue20th (feat.孫燕姿) - Single",
      duration_ms: 271019,
      isrc: "TWK231900073",
      _apple_album_track_count: 1,
      _apple_track_number: 1,
    },
  ];
  const maydayIdentity: any = {
    confirmed: true,
    method: "isrc",
    recording_mbid: "59bf84df-14a9-4b31-bf23-82e8589e19d9",
    release_mbid: "21e729b1-cdb6-4141-8427-4a367102d384",
    release_group_mbid: "3ed0ac93-517e-4870-ac6c-5cbac8d41b97",
    artist: "五月天",
    track: "溫柔 #MaydayBlue20th",
    album: "溫柔 #MaydayBlue20th",
    release_group: "温柔 #MaydayBlue20th (Tenderness #MaydayBlue20th)",
    release_group_release_mbids: ["21e729b1-cdb6-4141-8427-4a367102d384"],
  };
  const maydayRawAlbum: any = maydayApple[0]._apple_raw_album;
  const maydayQueries: any = [];
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    const album: any = url.searchParams.get("album");
    maydayQueries.push(album);
    if (album === maydayRawAlbum) {
      return new Response(
        JSON.stringify({
          album: {
            name: maydayRawAlbum,
            artist: "五月天",
            image: [{ "#text": "https://lastfm.example/mayday-single.jpg" }],
            tracks: {
              track: [
                { name: "溫柔 #MaydayBlue20th (feat.孫燕姿)", duration: 271 },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (album === maydayApple[0].album) {
      return new Response(
        JSON.stringify({
          album: {
            name: maydayApple[0].album,
            artist: "五月天",
            image: [
              { "#text": "https://lastfm.example/mayday-normalized.jpg" },
            ],
            tracks: {
              track: [
                { name: "溫柔 #MaydayBlue20th (feat.孫燕姿)", duration: 271 },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        album: {
          name: album,
          artist: "五月天",
          image: [
            {
              "#text":
                "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const maydayMapped: any = await api.mapConfirmedIdentityToLastFm(
    maydayApple[0],
    maydayApple,
    maydayIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    maydayMapped.artist !== "五月天" ||
    maydayMapped.name !== "溫柔 #MaydayBlue20th (feat.孫燕姿)" ||
    maydayMapped.album !== maydayRawAlbum ||
    maydayMapped.mbid !== maydayIdentity.recording_mbid ||
    !maydayMapped._lastfm_artwork_match
  ) {
    throw new Error("Apple raw single-title artwork mapping failed");
  }
  if (maydayQueries[0] !== maydayRawAlbum)
    throw new Error(
      "Native raw Single/EP title was not queried before the normalized title",
    );
  const dreamzSource: any = {
    id: "1514979607",
    type: "songs",
    catalog_id: "1514979607",
    artist: "梦飞船",
    album_artist: "梦飞船",
    name: "7-11 的愛戀 (7-11 Love)",
    album: "夢飛船 航行紀錄3 (Dreamz FM 3)",
    duration_ms: 281920,
    isrc: "AUV401932514",
    _apple_storefront: "cn",
    _apple_album_id: "1514979360",
    _apple_album_upc: "9339718398675",
    _apple_release_date: "2001",
    _apple_album_track_count: 15,
    _apple_track_number: 2,
    _metadata_source: "zh-Hans-CN",
    _is_source_storefront: true,
  };
  const dreamzLatin: any = {
    ...dreamzSource,
    artist: "Dreamz FM",
    album_artist: "Dreamz FM",
    _apple_storefront: "au",
    _metadata_source: "en-AU",
    _is_source_storefront: false,
    _apple_release_equivalence_method: "exact_apple_catalog_release",
  };
  const dreamzTraditional: any = {
    ...dreamzSource,
    artist: "夢飛船",
    album_artist: "夢飛船",
    _apple_storefront: "tw",
    _metadata_source: "zh-Hant-TW",
    _is_source_storefront: false,
    _apple_release_equivalence_method: "exact_apple_catalog_release",
  };
  const dreamzApple: any = [dreamzSource, dreamzLatin, dreamzTraditional];
  const dreamzSupplement: any = api.supplementalAppleNativeRegions(
    dreamzSource,
    api.preferredAppleRegionForIsrc(dreamzSource.isrc),
  );
  if (
    dreamzSupplement.length !== 1 ||
    dreamzSupplement[0].storefront !== "tw"
  ) {
    throw new Error(
      "Traditional Chinese Apple metadata did not add the TW storefront independently of the AU ISRC prefix",
    );
  }
  if (
    api.choosePreferredAppleTrack(dreamzSource, dreamzApple).artist !== "夢飛船"
  ) {
    throw new Error(
      "Exact TW metadata was not preferred for a Traditional Chinese release with a non-native ISRC prefix",
    );
  }
  const dreamzAliases: any = api.buildLegalLastFmAliases(
    dreamzTraditional,
    dreamzApple,
    null,
    null,
  );
  if (
    dreamzAliases[0]?.artist !== "夢飛船 (Dreamz FM)" ||
    dreamzAliases[0]?.source !== "apple_exact_release_artist_alias"
  ) {
    throw new Error(
      "Exact Apple cross-storefront artist aliases were not composed safely",
    );
  }
  const unsafeDreamzAliases: any = api.buildLegalLastFmAliases(
    dreamzTraditional,
    [
      dreamzSource,
      dreamzLatin,
      { ...dreamzTraditional, _apple_album_id: "wrong-release" },
    ],
    null,
    null,
  );
  if (
    unsafeDreamzAliases.some(
      (candidate?: any) =>
        candidate.source === "apple_exact_release_artist_alias",
    )
  ) {
    throw new Error(
      "Artist aliases were composed across non-identical Apple releases",
    );
  }
  let dreamzCombinedAttempts: any = 0;
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    const artist: any = url.searchParams.get("artist");
    if (artist === "夢飛船 (Dreamz FM)") {
      dreamzCombinedAttempts += 1;
      if (dreamzCombinedAttempts === 1) {
        return new Response("temporary failure", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          album: {
            name: dreamzTraditional.album,
            artist,
            image: [{ "#text": "https://lastfm.example/dreamzfm3.jpg" }],
            tracks: {
              track: Array.from({ length: 15 }, (_?: any, index?: any) => ({
                name:
                  index === 1
                    ? dreamzTraditional.name
                    : `Album Track ${index + 1}`,
                duration: index === 1 ? 282 : 180,
              })),
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        album: {
          name: url.searchParams.get("album"),
          artist,
          image: [
            {
              "#text":
                "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const dreamzMapped: any = await api.mapConfirmedIdentityToLastFm(
    dreamzTraditional,
    dreamzApple,
    null,
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    dreamzMapped.artist !== "夢飛船 (Dreamz FM)" ||
    dreamzMapped.name !== dreamzTraditional.name ||
    dreamzMapped.album !== dreamzTraditional.album ||
    dreamzMapped.mbid !== "" ||
    !dreamzMapped._lastfm_artwork_match
  ) {
    throw new Error("Exact Apple artist-alias artwork mapping failed");
  }
  if (dreamzCombinedAttempts !== 2)
    throw new Error(
      "Exact Apple artist alias was not retried after a transient Last.fm failure",
    );
  const easonApple: any = [
    {
      artist: "陳奕迅",
      album_artist: "陳奕迅",
      name: "陀飛輪",
      album: "Time Flies 2010",
      _apple_raw_album: "Time Flies 2010 - EP",
      duration_ms: 278133,
      isrc: "HKUM71000251",
      _apple_album_track_count: 6,
      _apple_track_number: 4,
      _metadata_source: "zh-Hant-HK",
    },
  ];
  const easonIdentity: any = {
    confirmed: true,
    method: "isrc",
    recording_mbid: "3eb66cba-a60d-41fc-8a7a-52c0f4504fc2",
    release_mbid: "ca67208c-c406-476a-900e-76a64f0a99a4",
    release_group_mbid: "fca67ca4-b1b2-4b83-bf2a-33d0163097e9",
    artist: "陳奕迅",
    track: "陀飛輪",
    album: "Time Flies",
    release_group: "Time Flies",
    release_group_release_mbids: [
      "ca67208c-c406-476a-900e-76a64f0a99a4",
      "3badc340-059f-4690-a633-b054c50c029b",
      "122fbd2f-00e4-438f-90ad-86cc5aa5000f",
    ],
  };
  const easonAlbumResponse: any = (
    mbid: any = "122fbd2f-00e4-438f-90ad-86cc5aa5000f",
    targetRank: any = 4,
  ) => ({
    album: {
      name: "Time Flies",
      artist: "陳奕迅",
      mbid,
      image: [{ "#text": "https://lastfm.example/time-flies.jpg" }],
      tracks: {
        track: Array.from({ length: 6 }, (_?: any, index?: any) => ({
          name: index === targetRank - 1 ? "陀飛輪" : `Track ${index + 1}`,
          duration: index === targetRank - 1 ? 376 : 180,
          "@attr": { rank: index + 1 },
        })),
      },
    },
  });
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    const album: any = url.searchParams.get("album");
    if (album === "Time Flies") {
      return new Response(JSON.stringify(easonAlbumResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        album: {
          name: album,
          artist: "陳奕迅",
          image: [
            {
              "#text":
                "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const easonMapped: any = await api.mapConfirmedIdentityToLastFm(
    easonApple[0],
    easonApple,
    easonIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    easonMapped.album !== "Time Flies" ||
    easonMapped.name !== "陀飛輪" ||
    easonMapped.mbid !== easonIdentity.recording_mbid ||
    !easonMapped._lastfm_artwork_match
  ) {
    throw new Error(
      "Confirmed release MBID did not tolerate an isolated Last.fm duration anomaly",
    );
  }
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    const album: any = url.searchParams.get("album");
    if (album === "Time Flies") {
      return new Response(
        JSON.stringify(easonAlbumResponse("wrong-release-mbid")),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        album: {
          name: album,
          artist: "陳奕迅",
          image: [
            {
              "#text":
                "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const easonWrongRelease: any = await api.mapConfirmedIdentityToLastFm(
    easonApple[0],
    easonApple,
    easonIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    easonWrongRelease._lastfm_artwork_match ||
    easonWrongRelease.album === "Time Flies"
  ) {
    throw new Error("Unconfirmed Last.fm release bypassed the duration guard");
  }
  const ipartmentSource: any = {
    id: "i.syntheticIpartmentPublicFixture",
    type: "library-songs",
    artist: "颜培珊",
    album_artist: "颜培珊",
    name: "I Remember the...",
    album: "爱情公寓4(原声大碟)",
    duration_ms: 201813,
    catalog_id: "952862698",
  };
  const ipartmentCatalog: any = api.appleCatalogItemToTrack(
    {
      id: "952862698",
      attributes: {
        artistName: "颜培珊",
        name: "I Remember the...",
        albumName: "爱情公寓4(原声大碟)",
        durationInMillis: 201813,
        isrc: "HKA411300002",
        trackNumber: 4,
      },
      relationships: {
        albums: {
          data: [
            {
              id: "952862667",
              attributes: {
                artistName: "群星",
                isCompilation: true,
                upc: "886444425179",
                releaseDate: "2014-01-15",
                trackCount: 13,
              },
            },
          ],
        },
      },
    },
    ipartmentSource,
    "cn",
  );
  if (
    ipartmentCatalog.album_artist !== "群星" ||
    !ipartmentCatalog._apple_is_compilation
  ) {
    throw new Error(
      "Apple album relationship did not override the compilation track artist",
    );
  }
  const ipartmentPreferred: any = {
    ...ipartmentCatalog,
    artist: "顏培珊",
    name: "I Remember the...",
    album: "愛情公寓4(原聲大碟)",
    album_artist: "群星",
    _metadata_source: "zh-Hant-HK",
    _is_source_storefront: false,
  };
  const ipartmentIdentity: any = {
    confirmed: true,
    method: "strict_search",
    recording_mbid: "de5ee8d1-a4e9-4657-a50d-bd59876f3afb",
    release_mbid: "1585fe5e-eebf-4ac2-9257-a9aa18634b85",
    release_group_mbid: "f258ad34-a72d-4956-b0eb-3957a507ccd0",
    artist: "顏培珊",
    track: "I Remember the...",
    album: "爱情公寓4 (原声大碟)",
    album_artist: "Various Artists",
    release_group: "爱情公寓4 (原声大碟)",
    release_group_release_mbids: ["1585fe5e-eebf-4ac2-9257-a9aa18634b85"],
    release_track_count: 13,
    release_track_number_confirmed: true,
  };
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    const method: any = url.searchParams.get("method");
    if (method === "album.search") {
      return new Response(
        JSON.stringify({
          results: {
            albummatches: {
              album: [
                {
                  name: "愛情公寓4(原聲大碟)",
                  artist: "iPartment 4 (Original Soundtrack)",
                  image: [
                    {
                      "#text":
                        "https://lastfm.example/ipartment-pseudo-artist.jpg",
                    },
                  ],
                },
                {
                  name: "爱情公寓4 原声大碟",
                  artist: "Various Artists",
                  image: [{ "#text": "https://lastfm.example/ipartment4.jpg" }],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        album: {
          name: url.searchParams.get("album"),
          artist: url.searchParams.get("artist"),
          image: [
            {
              "#text":
                "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const ipartmentMapped: any = await api.mapConfirmedIdentityToLastFm(
    ipartmentPreferred,
    [ipartmentCatalog, ipartmentPreferred],
    ipartmentIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    ipartmentMapped.artist !== "顏培珊" ||
    ipartmentMapped.name !== "I Remember the..." ||
    ipartmentMapped.album !== "爱情公寓4 原声大碟" ||
    ipartmentMapped.album_artist !== "Various Artists" ||
    ipartmentMapped.mbid !== ipartmentIdentity.recording_mbid ||
    !ipartmentMapped._lastfm_artwork_match
  ) {
    throw new Error(
      "Confirmed Various Artists compilation artwork alias mapping failed",
    );
  }
  globalThis.fetch = async (input?: any) => {
    const url: any = new URL(String(input));
    if (url.searchParams.get("method") === "album.search") {
      return new Response(
        JSON.stringify({
          results: {
            albummatches: {
              album: [
                {
                  name: "愛情公寓4(原聲大碟)",
                  artist: "iPartment 4 (Original Soundtrack)",
                  image: [
                    {
                      "#text":
                        "https://lastfm.example/ipartment-pseudo-artist.jpg",
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        album: {
          name: url.searchParams.get("album"),
          artist: url.searchParams.get("artist"),
          image: [
            {
              "#text":
                "https://lastfm-img.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png",
            },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const ipartmentPseudoOnly: any = await api.mapConfirmedIdentityToLastFm(
    ipartmentPreferred,
    [ipartmentCatalog, ipartmentPreferred],
    ipartmentIdentity,
    null,
    "api-key",
  );
  globalThis.fetch = realFetch;
  if (
    ipartmentPseudoOnly._lastfm_artwork_match ||
    ipartmentPseudoOnly.album_artist === "iPartment 4 (Original Soundtrack)"
  ) {
    throw new Error(
      "Pseudo soundtrack artist was accepted as a Various Artists release alias",
    );
  }
  testLog(
    JSON.stringify(
      {
        ok: true,
        xu_album: xuNative.album,
        jay_album: mapped.album,
        qinghua_album: qinghuaMapped.album,
        mayday_album: maydayMapped.album,
        dreamz_artist: dreamzMapped.artist,
        dreamz_album: dreamzMapped.album,
        eason_album: easonMapped.album,
        eason_recording_mbid: easonMapped.mbid,
        ipartment_artist: ipartmentMapped.artist,
        ipartment_album_artist: ipartmentMapped.album_artist,
        ipartment_album: ipartmentMapped.album,
        snail_track: snailMapped.name,
        snail_album: snailMapped.album,
        snail_recording_mbid: snailIdentity.recording_mbid,
        snail_release_mbid: snailIdentity.release_mbid,
        snail_release_group_mbid: snailIdentity.release_group_mbid,
        spotify_release_gap_triggered: Boolean(spotifyEvidence),
        fujii_track: fujiiNative.name,
        recording_mbid_only: true,
      },
      null,
      2,
    ),
  );
});
