import type {
  UserProfile,
  NamingRule,
  NameField,
  Identity,
  Names,
  PreparedTrack,
  ResolvedTrack,
  JsonStore,
} from "../../contracts/src/index";
import { defaultProfile } from "../../contracts/src/index";
const fields: NameField[] = ["artist", "album_artist", "track", "album"];
const kinds: (keyof Identity)[] = [
  "artist_mbid",
  "album_artist_mbid",
  "recording_mbid",
  "release_mbid",
  "release_group_mbid",
  "apple_track_id",
  "apple_album_id",
];
const allowedKinds: Record<NameField, (keyof Identity)[]> = {
  artist: ["artist_mbid"],
  album_artist: ["album_artist_mbid", "artist_mbid"],
  track: ["recording_mbid", "apple_track_id"],
  album: ["release_mbid", "release_group_mbid", "apple_album_id"],
};
const object = (x: unknown): x is Record<string, unknown> =>
  Boolean(x) && typeof x === "object" && !Array.isArray(x);
const nonempty = (x: unknown): x is string =>
  typeof x === "string" && x.trim().length > 0 && x.length <= 500;
const only = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).every((k) => keys.includes(k));
export function validateProfile(value: unknown): string[] {
  const errors: string[] = [];
  if (!object(value)) return ["profile must be an object"];
  if (!only(value, ["schema_version", "revision", "naming_strategy", "rules"]))
    errors.push("unknown profile field");
  if (value.schema_version !== 1) errors.push("schema_version must be 1");
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0)
    errors.push("revision must be a nonnegative integer");
  if (
    !["native_verified", "apple_source"].includes(String(value.naming_strategy))
  )
    errors.push("invalid naming_strategy");
  if (!Array.isArray(value.rules) || value.rules.length > 200)
    return [...errors, "rules must be an array with at most 200 entries"];
  const ids = new Set<string>();
  for (const [i, r] of value.rules.entries()) {
    const prefix = `rules[${i}]`;
    if (!object(r)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!only(r, ["id", "enabled", "field", "match", "value"]))
      errors.push(`${prefix}: unknown rule field`);
    if (!nonempty(r.id) || ids.has(r.id))
      errors.push(`${prefix}: invalid or duplicate id`);
    else ids.add(r.id);
    if (
      typeof r.enabled !== "boolean" ||
      !fields.includes(r.field as NameField) ||
      !nonempty(r.value)
    )
      errors.push(`${prefix}: invalid enabled, field or value`);
    if (!object(r.match)) {
      errors.push(`${prefix}: match required`);
      continue;
    }
    if (!only(r.match, ["identity", "aliases"]))
      errors.push(`${prefix}: unknown matcher`);
    if (r.match.identity !== undefined) {
      const id = r.match.identity;
      if (
        !object(id) ||
        !only(id, ["kind", "id"]) ||
        !kinds.includes(id.kind as keyof Identity) ||
        !nonempty(id.id) ||
        !allowedKinds[r.field as NameField]?.includes(id.kind as keyof Identity)
      )
        errors.push(`${prefix}: invalid identity selector`);
      else if (
        String(id.kind).endsWith("_mbid") &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          String(id.id),
        )
      )
        errors.push(`${prefix}: invalid MBID`);
    }
    if (
      r.match.aliases !== undefined &&
      (!Array.isArray(r.match.aliases) ||
        r.match.aliases.length === 0 ||
        r.match.aliases.length > 50 ||
        !r.match.aliases.every(nonempty))
    )
      errors.push(`${prefix}: invalid aliases`);
    if (!r.match.identity && !r.match.aliases)
      errors.push(`${prefix}: identity or aliases required`);
  }
  return errors;
}
const normalize = (s: string) =>
  s.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const isCompilation = (s: string) =>
  ["various artists", "various artist", "群星"].includes(normalize(s));
export function applyProfile(
  resolved: ResolvedTrack,
  profile: UserProfile,
): PreparedTrack {
  const source = resolved.source;
  const standard: Names =
    profile.naming_strategy === "apple_source"
      ? {
          artist: source.artist,
          album_artist: source.album_artist || source.artist,
          track: source.name,
          album: source._apple_raw_album ?? source.album,
        }
      : { ...resolved.canonical };
  const lastfm = { ...standard };
  const applications: PreparedTrack["rules"] = [];
  const changed = new Set<NameField>();
  for (const rule of profile.rules) {
    if (!rule.enabled || changed.has(rule.field)) continue;
    if (
      rule.field === "album_artist" &&
      (source._apple_is_compilation === true ||
        isCompilation(standard.album_artist) ||
        isCompilation(resolved.canonical.album_artist))
    )
      continue;
    let matchedBy: "identity" | "alias" | null = null;
    const selector = rule.match.identity;
    if (selector) {
      let actual = resolved.identity[selector.kind];
      if (rule.field === "album_artist" && selector.kind === "artist_mbid") {
        actual = resolved.identity.album_artist_mbid;
        if (
          !actual &&
          normalize(standard.album_artist) === normalize(standard.artist)
        )
          actual = resolved.identity.artist_mbid;
        if (
          !actual &&
          normalize(standard.album_artist) !== normalize(standard.artist)
        )
          continue;
      }
      if (actual) {
        if (actual !== selector.id) continue;
        matchedBy = "identity";
      }
    }
    if (
      !matchedBy &&
      rule.match.aliases?.some(
        (alias) => normalize(alias) === normalize(standard[rule.field]),
      )
    )
      matchedBy = "alias";
    if (!matchedBy) continue;
    applications.push({
      rule_id: rule.id,
      field: rule.field,
      before: standard[rule.field],
      after: rule.value,
      matched_by: matchedBy,
    });
    lastfm[rule.field] = rule.value;
    changed.add(rule.field);
  }
  return {
    resolved: structuredClone(resolved),
    standard,
    display: { ...lastfm },
    lastfm,
    listenbrainz: { ...standard },
    rules: applications,
    profile_revision: profile.revision,
  };
}
export class ProfileError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class ProfileRepository {
  constructor(private store: JsonStore) {}
  async get(): Promise<UserProfile> {
    const profile =
      (await this.store.get<UserProfile>("profile:v1")) ?? defaultProfile();
    if (validateProfile(profile).length)
      throw new Error("stored profile is invalid");
    return profile;
  }
  async replace(candidate: unknown): Promise<UserProfile> {
    const errors = validateProfile(candidate);
    if (errors.length) throw new ProfileError(400, errors.join("; "));
    const profile = candidate as UserProfile;
    const current = await this.get();
    if (current.revision !== profile.revision)
      throw new ProfileError(409, "profile revision conflict");
    const next = structuredClone({
      ...profile,
      revision: profile.revision + 1,
    });
    await this.store.put("profile:v1", next);
    return next;
  }
}
export function validateResolvedTrack(x: unknown): x is ResolvedTrack {
  if (
    !object(x) ||
    !object(x.source) ||
    !object(x.canonical) ||
    !object(x.identity) ||
    !object(x.evidence)
  )
    return false;
  return (
    nonempty(x.source.id) &&
    nonempty(x.source.name) &&
    nonempty(x.source.artist) &&
    typeof x.source.album === "string" &&
    typeof x.source.duration_ms === "number" &&
    Number.isFinite(x.source.duration_ms) &&
    x.source.duration_ms > 0 &&
    fields.every(
      (k) => typeof (x.canonical as Record<string, unknown>)[k] === "string",
    ) &&
    Object.values(x.identity).every((v) => v === null || typeof v === "string")
  );
}
