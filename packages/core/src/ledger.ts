import type {
  Ledger,
  PendingEnrichment,
  Resource,
  SubmissionRecord,
  UserProfile,
} from "../../contracts/src/index";
import { defaultProfile } from "../../contracts/src/index";
import { md5 } from "./md5";
export const eventId = (trackId: string, timestamp: string): string =>
  md5(`${trackId}\n${timestamp}`);
export function emptyLedger(): Ledger {
  return {
    version: 1,
    schema_version: 2,
    history_source_version: 2,
    last_run_iso: null,
    previous_recent: [],
    pending_enrichments: [],
    pending_scrobbles: [],
    recent_scrobbles: [],
    submission_records: [],
    log_entries: [],
    stats: {
      total_scrobbled: 0,
      total_runs: 0,
      total_errors: 0,
      last_success_iso: null,
      last_error_iso: null,
      last_error_message: null,
    },
  };
}
function validDate(x: unknown): x is string {
  return typeof x === "string" && Number.isFinite(Date.parse(x));
}
/** Pure migration: validate the whole input before producing a copy. Never writes. */
export function migrateLedger(
  input: unknown,
  profile: UserProfile = defaultProfile(),
): Ledger {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid ledger");
  const raw = structuredClone(input) as Resource;
  if (
    raw.version !== 1 ||
    (raw.schema_version !== undefined && raw.schema_version !== 2)
  )
    throw new Error("unsupported ledger version");
  for (const k of [
    "previous_recent",
    "recent_scrobbles",
    "pending_enrichments",
    "pending_scrobbles",
    "submission_records",
    "log_entries",
  ])
    if (raw[k] !== undefined && !Array.isArray(raw[k]))
      throw new Error(`invalid ${k}`);
  if (
    raw.previous_recent?.some((t: Resource) => !t || typeof t.id !== "string")
  )
    throw new Error("invalid previous_recent");
  for (const item of raw.pending_scrobbles ?? [])
    if (
      !item ||
      !validDate(item.timestamp_iso) ||
      typeof item.track_id !== "string" ||
      typeof item.artist !== "string" ||
      typeof item.track !== "string"
    )
      throw new Error("invalid pending scrobble");
  for (const item of raw.pending_enrichments ?? [])
    if (
      !item ||
      !validDate(item.timestamp_iso) ||
      typeof item.track?.id !== "string"
    )
      throw new Error("invalid pending enrichment");
  const base = emptyLedger();
  const migrated: Ledger = {
    ...base,
    ...raw,
    schema_version: 2,
    stats: { ...base.stats, ...raw.stats },
    last_detection_iso: raw.last_detection_iso ?? raw.last_run_iso ?? null,
  };
  migrated.pending_enrichments = (raw.pending_enrichments ?? []).map(
    (item: Resource): PendingEnrichment =>
      ({
        ...item,
        event_id: item.event_id ?? eventId(item.track.id, item.timestamp_iso),
        profile: item.profile ?? structuredClone(profile),
        profile_origin:
          item.profile_origin ?? (item.profile ? undefined : "legacy"),
      }) as PendingEnrichment,
  );
  migrated.pending_scrobbles = (raw.pending_scrobbles ?? []).map(
    (item: Resource): SubmissionRecord =>
      ({
        ...item,
        event_id: item.event_id ?? eventId(item.track_id, item.timestamp_iso),
        status: item.status ?? "pending",
        attempts: item.attempts ?? 0,
        profile_revision: item.profile_revision ?? "legacy",
      }) as SubmissionRecord,
  );
  for (const queue of [
    migrated.pending_enrichments,
    migrated.pending_scrobbles,
  ])
    if (new Set(queue.map((i) => i.event_id)).size !== queue.length)
      throw new Error(
        "duplicate event IDs in legacy queue; resolve before migration",
      );
  return migrated;
}
export function log(
  ledger: Ledger,
  now: number,
  step: string,
  details: string,
  level = "info",
) {
  ledger.log_entries.unshift({
    timestamp_iso: new Date(now).toISOString(),
    step,
    details,
    level,
  });
  ledger.log_entries = ledger.log_entries.slice(0, 50);
}
