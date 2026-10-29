import { describe, expect, it } from "vitest";
import {
  applyProfile,
  ProfileRepository,
  validateProfile,
} from "../packages/profiles/src/index";
import {
  defaultProfile,
  type ResolvedTrack,
  type UserProfile,
} from "../packages/contracts/src/index";
import { MemoryStore } from "../packages/storage/src/index";
import example from "../examples/fujii-kaze.profile.json";
const artistId = "c3a4aeca-8f02-4d22-b1ff-693434ab09a8";
const sample = (): ResolvedTrack => ({
  source: {
    id: "source",
    name: "Nan-Nan",
    artist: "Fujii Kaze",
    album: "HELP EVER HURT NEVER - EP",
    duration_ms: 180000,
  },
  identity: {
    artist_mbid: artistId,
    recording_mbid: "recording",
    release_mbid: "release",
  },
  canonical: {
    artist: "藤井風",
    album_artist: "藤井風",
    track: "何なんw",
    album: "HELP EVER HURT NEVER",
  },
  evidence: { artwork_match: true },
});
const profile = () => structuredClone(example) as UserProfile;
describe("naming profiles", () => {
  it("default contains no personal rule and native results are unchanged", () => {
    const s = sample();
    expect(applyProfile(s, defaultProfile()).lastfm).toEqual(s.canonical);
  });
  it("source strategy preserves original labels but not a different identity", () => {
    const s = sample();
    const result = applyProfile(s, {
      ...defaultProfile(),
      naming_strategy: "apple_source",
    });
    expect(result.lastfm).toMatchObject({
      artist: "Fujii Kaze",
      track: "Nan-Nan",
      album: "HELP EVER HURT NEVER - EP",
    });
    expect(result.resolved.identity).toEqual(s.identity);
  });
  it("personal rule affects display and Last.fm, not ListenBrainz or source", () => {
    const s = sample();
    const before = structuredClone(s);
    const out = applyProfile(s, profile());
    expect(out.lastfm.artist).toBe("藤井 風");
    expect(out.display).toEqual(out.lastfm);
    expect(out.listenbrainz.artist).toBe("藤井風");
    expect(s).toEqual(before);
    expect(out.rules).toHaveLength(2);
  });
  it("disabled rules have no effect", () => {
    const p = profile();
    p.rules.forEach((r) => (r.enabled = false));
    expect(applyProfile(sample(), p).rules).toEqual([]);
  });
  it("known conflicting identity cannot be bypassed with aliases", () => {
    const s = sample();
    s.identity.artist_mbid = "different";
    expect(applyProfile(s, profile()).lastfm.artist).toBe("藤井風");
  });
  it("explicit aliases apply only when identity is absent", () => {
    const s = sample();
    s.identity = {};
    expect(applyProfile(s, profile()).lastfm.artist).toBe("藤井 風");
  });
  it("compilation album artist remains Various Artists", () => {
    const s = sample();
    s.canonical.album_artist = "Various Artists";
    s.source._apple_is_compilation = true;
    expect(applyProfile(s, profile()).lastfm).toMatchObject({
      artist: "藤井 風",
      album_artist: "Various Artists",
    });
  });
  it("different album artist identity is not overwritten", () => {
    const s = sample();
    s.identity.album_artist_mbid = "someone-else";
    expect(applyProfile(s, profile()).lastfm.album_artist).toBe("藤井風");
  });
  it("first rule wins without chaining", () => {
    const p = profile();
    p.rules.push({ ...p.rules[0], id: "second", value: "Other" });
    p.rules.push({
      id: "chained",
      enabled: true,
      field: "album",
      match: { aliases: ["藤井 風"] },
      value: "wrong",
    });
    expect(applyProfile(sample(), p).lastfm.artist).toBe("藤井 風");
    expect(applyProfile(sample(), p).lastfm.album).toBe("HELP EVER HURT NEVER");
  });
  it.each(["track", "album"] as const)(
    "supports %s overrides by exact stable selector",
    (field) => {
      const p = defaultProfile();
      p.rules = [
        {
          id: "rename",
          enabled: true,
          field,
          match: {
            identity: {
              kind: field === "track" ? "apple_track_id" : "apple_album_id",
              id: "id",
            },
          },
          value: "User name",
        },
      ];
      const s = sample();
      s.identity.apple_track_id = "id";
      s.identity.apple_album_id = "id";
      expect(applyProfile(s, p).lastfm[field]).toBe("User name");
    },
  );
  it("rejects credentials, script actions, invalid MBIDs and duplicate IDs", () => {
    expect(validateProfile({ ...profile(), secret: "x" })).not.toHaveLength(0);
    const p = profile();
    p.rules.push(p.rules[0]);
    expect(validateProfile(p)).not.toHaveLength(0);
    expect(
      validateProfile({
        ...profile(),
        rules: [{ ...profile().rules[0], script: "x" }],
      }),
    ).not.toHaveLength(0);
  });
  it("revision conflict and invalid input preserve the previous profile", async () => {
    const repo = new ProfileRepository(new MemoryStore());
    const saved = await repo.replace(profile());
    await expect(repo.replace(profile())).rejects.toMatchObject({
      status: 409,
    });
    await expect(repo.replace({ revision: 1 })).rejects.toMatchObject({
      status: 400,
    });
    expect(await repo.get()).toEqual(saved);
  });
  it("profiles and cached objects are isolated across repositories", async () => {
    const a = new ProfileRepository(new MemoryStore()),
      b = new ProfileRepository(new MemoryStore());
    await a.replace(profile());
    expect((await b.get()).rules).toEqual([]);
    const returned = await a.get();
    returned.rules = [];
    expect((await a.get()).rules).toHaveLength(2);
  });
});
