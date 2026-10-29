/** Flexible upstream resource envelope; domain records below have explicit contracts. */
export type Resource = Record<string, any>;
export interface Track extends Resource {
  id: string;
  name: string;
  artist: string;
  album: string;
  album_artist?: string;
  duration_ms: number;
  isrc?: string;
}
export interface Names {
  artist: string;
  album_artist: string;
  track: string;
  album: string;
}
export type NameField = keyof Names;
export interface Identity {
  artist_mbid?: string | null;
  album_artist_mbid?: string | null;
  recording_mbid?: string | null;
  release_mbid?: string | null;
  release_group_mbid?: string | null;
  apple_track_id?: string | null;
  apple_album_id?: string | null;
}
export interface NamingRule {
  id: string;
  enabled: boolean;
  field: NameField;
  match: {
    identity?: { kind: keyof Identity; id: string };
    aliases?: string[];
  };
  value: string;
}
export interface UserProfile {
  schema_version: 1;
  revision: number;
  naming_strategy: "native_verified" | "apple_source";
  rules: NamingRule[];
}
export interface RuleApplication {
  rule_id: string;
  field: NameField;
  before: string;
  after: string;
  matched_by: "identity" | "alias";
}
export interface ResolvedTrack {
  source: Track;
  identity: Identity;
  canonical: Names;
  evidence: Resource;
}
export interface PreparedTrack {
  resolved: ResolvedTrack;
  standard: Names;
  display: Names;
  lastfm: Names;
  listenbrainz: Names;
  rules: RuleApplication[];
  profile_revision: number | "legacy";
}
export interface PendingEnrichment {
  event_id: string;
  track: Track;
  timestamp_iso: string;
  kind: string;
  queued_at_iso: string;
  profile: UserProfile;
  profile_origin?: "legacy";
  last_error?: string;
}
export type SubmissionStatus =
  "pending" | "accepted" | "ignored" | "failed" | "uncertain";
export interface SubmissionRecord {
  event_id: string;
  track_id: string;
  artist: string;
  track: string;
  album: string;
  album_artist: string;
  mbid: string;
  mbid_kind: string;
  duration_ms: number;
  timestamp_iso: string;
  kind: string;
  queued_at_iso: string;
  status: SubmissionStatus;
  prepared?: PreparedTrack;
  profile_revision: number | "legacy";
  attempts: number;
  returned?: Partial<Names>;
  last_error?: string;
}
export interface Stats {
  total_scrobbled: number;
  total_runs: number;
  total_errors: number;
  last_success_iso: string | null;
  last_error_iso: string | null;
  last_error_message: string | null;
}
export interface Ledger extends Resource {
  version: number;
  schema_version: 2;
  history_source_version: number;
  previous_recent: Track[];
  pending_enrichments: PendingEnrichment[];
  pending_scrobbles: SubmissionRecord[];
  recent_scrobbles: Resource[];
  submission_records: SubmissionRecord[];
  stats: Stats;
  last_run_iso: string | null;
  log_entries: Resource[];
}
export interface JsonStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface RawKv {
  get(key: string, type?: string): Promise<any>;
  put(key: string, value: string, options?: Resource): Promise<void>;
  delete?(key: string): Promise<void>;
}
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface SubmissionOutcome {
  event_id: string;
  status: Exclude<SubmissionStatus, "pending">;
  returned?: Partial<Names>;
  error?: string;
}
export interface AppleCredentials {
  apple_dev_token: string;
  apple_user_token: string;
}
export interface AppleAccessResult {
  ok: boolean;
  code?: "apple_rejected" | "apple_unavailable" | "apple_invalid_response";
}
export interface Services {
  verifyApple?(credentials: AppleCredentials): Promise<AppleAccessResult>;
  recent(): Promise<Track[]>;
  resolve(track: Track): Promise<ResolvedTrack>;
  submit(items: SubmissionRecord[]): Promise<SubmissionOutcome[]>;
  playCount?(track: Track): Promise<number | null>;
  secondary?(items: SubmissionRecord[]): Promise<void>;
}
export const defaultProfile = (): UserProfile => ({
  schema_version: 1,
  revision: 0,
  naming_strategy: "native_verified",
  rules: [],
});
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
