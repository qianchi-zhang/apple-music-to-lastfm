import type {
  Clock,
  JsonStore,
  Ledger,
  PendingEnrichment,
  Resource,
  Services,
  SubmissionRecord,
  UserProfile,
} from "../../contracts/src/index";
import { defaultProfile } from "../../contracts/src/index";
import { applyProfile } from "../../profiles/src/index";
import {
  detectPlays,
  filterImplausibleInferredRepeats,
  assignTimestamps,
} from "./detection";
import { emptyLedger, eventId, log, migrateLedger } from "./ledger";
export interface EngineOptions {
  store: JsonStore;
  services: Services;
  clock: Clock;
  profile: () => Promise<UserProfile>;
  capacity?: number;
}
/** Caller serializes every mutation; no module-global state or provider credentials. */
export class Engine {
  readonly capacity: number;
  constructor(private deps: EngineOptions) {
    this.capacity = deps.capacity ?? 1000;
  }
  async status(): Promise<Ledger> {
    const raw = await this.deps.store.get<unknown>("ledger:v1");
    return raw === null ? emptyLedger() : migrateLedger(raw);
  }
  private save(l: Ledger) {
    return this.deps.store.put("ledger:v1", l);
  }
  async initializeBaseline() {
    const current = await this.deps.services.recent();
    const ledger = await this.status();
    ledger.previous_recent = current;
    ledger.history_source_version = 2;
    ledger.last_detection_iso = new Date(this.deps.clock.now()).toISOString();
    ledger.last_successful_poll_iso = ledger.last_detection_iso;
    ledger.last_save_iso = ledger.last_detection_iso;
    delete ledger.top_track_id;
    delete ledger.top_track_play_count;
    ledger.stationary_idle = false;
    ledger.handled_count = 1;
    await this.save(ledger);
  }
  async run(manual = false) {
    const { clock, services } = this.deps;
    const now = clock.now();
    const ledger = await this.status();
    if (
      !manual &&
      ledger.circuit_open_until_iso &&
      Date.parse(ledger.circuit_open_until_iso) > now
    )
      return { ok: false, circuit_open: true };
    ledger.stats.total_runs++;
    ledger.last_run_iso = new Date(now).toISOString();
    log(ledger, now, "poll_start", manual ? "Manual run" : "Scheduled run");
    let detected = 0,
      accepted = 0,
      captureBlocked = false;
    try {
      // Snapshot before any enqueue: configuration changes cannot rewrite queued work.
      const profile = await this.deps.profile();
      const current = await services.recent();
      const since =
        ledger.last_detection_iso ??
        ledger.last_successful_poll_iso ??
        ledger.last_save_iso;
      const elapsed = since
        ? Math.max(0, (now - Date.parse(since)) / 1000)
        : 180;
      if (
        !ledger.previous_recent.length ||
        ledger.history_source_version !== 2
      ) {
        ledger.previous_recent = current;
        ledger.history_source_version = 2;
        ledger.last_detection_iso = new Date(now).toISOString();
      } else {
        const oldTop = {
          id: ledger.top_track_id,
          count: ledger.top_track_play_count,
        };
        const detection = detectPlays(
          current,
          ledger.previous_recent,
          elapsed,
          {
            stationaryIdle: ledger.stationary_idle,
            handledCount: ledger.handled_count,
          },
        );
        let plays = detection.plays;
        if (
          !plays.length &&
          current[0]?.id === ledger.previous_recent[0]?.id &&
          services.playCount
        ) {
          const count = await services.playCount(current[0]);
          if (count !== null) {
            if (
              ledger.top_track_id === current[0].id &&
              typeof ledger.top_track_play_count === "number" &&
              count > ledger.top_track_play_count
            )
              plays = Array.from(
                {
                  length: Math.min(
                    count - ledger.top_track_play_count,
                    this.capacity + 1,
                  ),
                },
                () => ({ track: current[0], kind: "repeat" }),
              );
            ledger.top_track_id = current[0].id;
            ledger.top_track_play_count = count;
          }
        }
        const guarded = filterImplausibleInferredRepeats(plays, elapsed);
        if (guarded.dropped)
          log(
            ledger,
            now,
            "repeat_burst_blocked",
            String(guarded.dropped),
            "warn",
          );
        const recentIds = ledger.recent_scrobble_ids ?? [];
        const filtered = guarded.plays.filter(
          (p: Resource) =>
            !recentIds.includes(`${p.track.id}:${Math.floor(now / 30000)}`) &&
            !recentIds.includes(`${p.track.id}:${Math.floor(now / 30000) - 1}`),
        );
        const dated = assignTimestamps(
          filtered,
          new Date(now),
          since ? new Date(since) : null,
        );
        const known = new Set(
          [
            ...ledger.pending_enrichments,
            ...ledger.pending_scrobbles,
            ...ledger.submission_records,
          ].map((i) => i.event_id),
        );
        const additions: PendingEnrichment[] = dated
          .map((p: Resource) => ({
            event_id: eventId(p.track.id, p.timestamp.toISOString()),
            track: structuredClone(p.track),
            timestamp_iso: p.timestamp.toISOString(),
            kind: p.kind,
            queued_at_iso: new Date(now).toISOString(),
            profile: structuredClone(profile),
          }))
          .filter((p: PendingEnrichment) => !known.has(p.event_id));
        if (
          ledger.pending_enrichments.length + additions.length >
          this.capacity
        ) {
          captureBlocked = true;
          ledger.top_track_id = oldTop.id;
          ledger.top_track_play_count = oldTop.count;
          log(
            ledger,
            now,
            "queue_full",
            "Capture snapshot retained; drain pending work before capturing more",
            "error",
          );
        } else {
          ledger.pending_enrichments.push(...additions);
          detected = additions.length;
          ledger.previous_recent = current;
          ledger.last_detection_iso = new Date(now).toISOString();
          ledger.stationary_idle = detection.newState.stationaryIdle;
          ledger.handled_count = detection.newState.handledCount;
        }
      }
      // Persist source plays before enrichment makes any external request.
      ledger.last_save_iso = new Date(now).toISOString();
      await this.save(ledger);
      const retained: PendingEnrichment[] = [];
      for (const pending of ledger.pending_enrichments) {
        if (ledger.pending_scrobbles.length >= this.capacity) {
          retained.push(pending);
          continue;
        }
        try {
          const resolved = await services.resolve(pending.track);
          const prepared = applyProfile(
            resolved,
            pending.profile ?? defaultProfile(),
          );
          ledger.pending_scrobbles.push({
            event_id: pending.event_id,
            track_id: pending.track.id,
            ...prepared.lastfm,
            mbid: resolved.identity.recording_mbid ?? "",
            mbid_kind: resolved.identity.recording_mbid ? "recording" : "",
            duration_ms: pending.track.duration_ms,
            timestamp_iso: pending.timestamp_iso,
            kind: pending.kind,
            queued_at_iso: pending.queued_at_iso,
            status: "pending",
            prepared,
            profile_revision:
              pending.profile_origin === "legacy"
                ? "legacy"
                : prepared.profile_revision,
            attempts: 0,
          });
        } catch (error) {
          retained.push({ ...pending, last_error: String(error) });
          log(
            ledger,
            now,
            "pending_enrichment_deferred",
            `${pending.track.name}: ${String(error)}`,
            "warn",
          );
        }
      }
      ledger.pending_enrichments = retained;
      await this.save(ledger);
      // Uncertain outcomes require explicit reconciliation; do not blindly resubmit.
      const batch = ledger.pending_scrobbles
        .filter((i) => i.status !== "uncertain")
        .slice(0, 50);
      if (batch.length) {
        // Crash after dispatch must not turn into an automatic duplicate submission.
        for (const item of batch) {
          item.status = "uncertain";
          item.attempts++;
          item.last_error = "submission_in_flight";
        }
        await this.save(ledger);
        let outcomes = await services.submit(batch);
        const retry = batch.filter(
          (i) =>
            outcomes.find((o) => o.event_id === i.event_id)?.status ===
            "failed",
        );
        if (retry.length) {
          await clock.sleep(1000);
          for (const item of retry) item.attempts++;
          await this.save(ledger);
          const next = await services.submit(retry);
          const replaced = new Set(retry.map((i) => i.event_id));
          outcomes = [
            ...outcomes.filter((o) => !replaced.has(o.event_id)),
            ...next,
          ];
        }
        const committed: SubmissionRecord[] = [];
        for (const item of batch) {
          const matches = outcomes.filter((o) => o.event_id === item.event_id);
          const outcome = matches.length === 1 ? matches[0] : null;
          item.status = outcome?.status ?? "uncertain";
          item.returned = outcome?.returned;
          item.last_error =
            outcome?.error ??
            (outcome ? undefined : "missing_submission_response");
          if (item.status === "accepted") committed.push(structuredClone(item));
        }
        const committedIds = new Set(committed.map((i) => i.event_id));
        ledger.pending_scrobbles = ledger.pending_scrobbles.filter(
          (i) => !committedIds.has(i.event_id),
        );
        accepted = committed.length;
        ledger.submission_records.unshift(...committed);
        ledger.submission_records = ledger.submission_records.slice(0, 1000);
        ledger.recent_scrobbles.unshift(
          ...committed.map((i) => ({
            ...i,
            artist: i.prepared?.display.artist ?? i.artist,
            track: i.prepared?.display.track ?? i.track,
            album: i.prepared?.display.album ?? i.album,
          })),
        );
        ledger.recent_scrobbles = ledger.recent_scrobbles.slice(0, 1000);
        ledger.stats.total_scrobbled += accepted;
        ledger.recent_scrobble_ids = [
          ...new Set([
            ...committed.map((i) => `${i.track_id}:${Math.floor(now / 30000)}`),
            ...(ledger.recent_scrobble_ids ?? []).filter(
              (id: string) =>
                Number(id.split(":").at(-1)) >= Math.floor(now / 30000) - 1,
            ),
          ]),
        ];
        await this.save(ledger);
        if (committed.length && services.secondary) {
          try {
            await services.secondary(committed);
          } catch (error) {
            log(ledger, now, "secondary_submit_failed", String(error), "warn");
          }
        }
      }
      const failed = ledger.pending_scrobbles.find(
        (i) => i.status !== "pending",
      );
      ledger.stats.last_error_message =
        failed?.last_error ?? (captureBlocked ? "queue_full" : null);
      ledger.stats.last_error_iso =
        failed || captureBlocked ? new Date(now).toISOString() : null;
      if (!failed && !captureBlocked)
        ledger.stats.last_success_iso = new Date(now).toISOString();
      ledger.consecutive_errors = 0;
      delete ledger.circuit_open_until_iso;
      log(
        ledger,
        now,
        "poll_complete",
        `${accepted} accepted; ${ledger.pending_enrichments.length} awaiting identity; ${ledger.pending_scrobbles.length} awaiting confirmation`,
      );
      ledger.last_successful_poll_iso = new Date(now).toISOString();
      await this.save(ledger);
      return {
        ok: !failed && !captureBlocked,
        detected,
        accepted,
        ignored: batchCount(ledger, "ignored"),
        errors: batchCount(ledger, "failed"),
        deferred_enrichments: ledger.pending_enrichments.length,
      };
    } catch (error) {
      ledger.stats.total_errors++;
      ledger.stats.last_error_message = String(error);
      ledger.stats.last_error_iso = new Date(now).toISOString();
      ledger.consecutive_errors = (ledger.consecutive_errors ?? 0) + 1;
      if (ledger.consecutive_errors >= 3)
        ledger.circuit_open_until_iso = new Date(
          now + 15 * 60000,
        ).toISOString();
      log(ledger, now, "poll_error", String(error), "error");
      await this.save(ledger);
      return { ok: false, detected, accepted, error: String(error) };
    }
  }
  async recover(items: unknown, dryRun = true) {
    if (!Array.isArray(items) || !items.length || items.length > 20)
      throw new Error("items must contain 1 to 20 entries");
    const l = await this.status();
    const profile = await this.deps.profile();
    const now = this.deps.clock.now();
    const prepared: SubmissionRecord[] = [];
    const ids = new Set<string>();
    for (const item of items) {
      const stamp = Date.parse(item?.timestamp_iso);
      const source = l.previous_recent.find((t) => t.id === item?.track_id);
      if (
        !source ||
        !Number.isFinite(stamp) ||
        stamp > now + 300000 ||
        stamp < now - 14 * 86400000
      )
        throw new Error("invalid recovery source or timestamp");
      const id = eventId(source.id, new Date(stamp).toISOString());
      if (ids.has(id)) throw new Error("duplicate recovery event");
      ids.add(id);
      const resolved = await this.deps.services.resolve(source);
      const output = applyProfile(resolved, profile);
      prepared.push({
        event_id: id,
        track_id: source.id,
        ...output.lastfm,
        mbid: resolved.identity.recording_mbid ?? "",
        mbid_kind: resolved.identity.recording_mbid ? "recording" : "",
        duration_ms: source.duration_ms,
        timestamp_iso: new Date(stamp).toISOString(),
        kind: "replacement",
        queued_at_iso: new Date(now).toISOString(),
        status: "pending",
        prepared: output,
        profile_revision: profile.revision,
        attempts: 0,
      });
    }
    if (dryRun) return { ok: true, dry_run: true, preview: prepared };
    const known = new Set(
      [
        ...l.pending_enrichments,
        ...l.pending_scrobbles,
        ...l.submission_records,
      ].map((i) => i.event_id),
    );
    if (prepared.some((i) => known.has(i.event_id)))
      throw new Error(
        "recovery event already exists; reconcile existing record",
      );
    if (l.pending_scrobbles.length + prepared.length > this.capacity)
      throw new Error("queue full");
    l.pending_scrobbles.push(...prepared);
    await this.save(l);
    return {
      ok: true,
      dry_run: false,
      queued: prepared.length,
      preview: prepared,
    };
  }
}
function batchCount(l: Ledger, status: string) {
  return l.pending_scrobbles.filter((i) => i.status === status).length;
}
