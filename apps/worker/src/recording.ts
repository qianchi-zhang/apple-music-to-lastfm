import type { Clock, JsonStore } from "../../../packages/contracts/src/index";
import { Application } from "./application";

export interface AlarmStorage {
  setAlarm(time: number): Promise<unknown>;
  deleteAlarm(): Promise<unknown>;
  getAlarm(): Promise<number | null>;
}
interface RecordingState {
  enabled: boolean;
  changed_at: string | null;
}
interface Connections {
  apple: { connected: boolean };
  lastfm: { connected: boolean; username?: string };
}
export class RecordingError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
/** All control and scheduler mutations use the same application queue. */
export class Recording {
  constructor(
    private app: Application,
    private store: JsonStore,
    private alarms: AlarmStorage,
    private clock: Clock,
    private connections: () => Promise<Connections>,
  ) {}
  private async state(): Promise<RecordingState> {
    const explicit = await this.store.get<RecordingState>("recording:v1");
    if (explicit) return explicit;
    // Preserve existing deployed schedulers; fresh instances remain stopped.
    return {
      enabled: !!(await this.store.get("schedule:v1")),
      changed_at: null,
    };
  }
  private async arm(enabled: boolean) {
    if (!enabled) return this.alarms.deleteAlarm();
    const schedule = await this.store.get<{ next_run_ms: number }>(
      "schedule:v1",
    );
    // A skipped Cron must not push an already-due Alarm another three minutes away.
    return this.alarms.setAlarm(
      Math.max(
        this.clock.now() + 1000,
        schedule?.next_run_ms ?? this.clock.now() + 180000,
      ),
    );
  }
  async status() {
    const state = await this.state();
    const ledger = await this.app.engine.status();
    const schedule = await this.store.get<{ next_run_ms: number }>(
      "schedule:v1",
    );
    return {
      ...state,
      interval_seconds: 180,
      next_run_ms: state.enabled ? (schedule?.next_run_ms ?? null) : null,
      alarm_ms: await this.alarms.getAlarm(),
      last_run_iso: ledger.last_run_iso,
      last_detection_iso: ledger.last_detection_iso ?? null,
      stats: {
        total_scrobbled: ledger.stats.total_scrobbled,
        total_runs: ledger.stats.total_runs,
        total_errors: ledger.stats.total_errors,
        last_error_iso: ledger.stats.last_error_iso,
        last_success_iso: ledger.stats.last_success_iso,
      },
      pending_identity: ledger.pending_enrichments.length,
      pending_submission: ledger.pending_scrobbles.length,
      pending_identity_records: ledger.pending_enrichments
        .slice(0, 30)
        .map((r) => ({
          event_id: r.event_id,
          track: r.track.name,
          artist: r.track.artist,
          album: r.track.album,
          status: "identifying",
          timestamp_iso: r.timestamp_iso,
          attempts: 0,
          source: r.track,
          needs_attention: !!r.last_error,
        })),
      records: [...ledger.pending_scrobbles, ...ledger.submission_records]
        .sort((a, b) => b.timestamp_iso.localeCompare(a.timestamp_iso))
        .slice(0, 30)
        .map((r) => ({
          event_id: r.event_id,
          track: r.track,
          artist: r.artist,
          album: r.album,
          status: r.status,
          timestamp_iso: r.timestamp_iso,
          attempts: r.attempts,
          // Display controlled guidance instead of potentially sensitive raw provider errors.
          needs_attention: r.status !== "accepted" && r.status !== "pending",
          source: r.prepared?.resolved.source,
          identity: r.prepared?.resolved.identity,
          standard: r.prepared?.standard,
          submitted: r.prepared?.lastfm,
          returned: r.returned,
          rules: r.prepared?.rules,
        })),
      events: ledger.log_entries
        .slice(0, 10)
        .map((e) => ({ time: e.timestamp_iso, step: e.step, level: e.level })),
    };
  }
  start(username: string) {
    return this.app.serialize(async () => {
      const c = await this.connections();
      if (!c.apple.connected || !c.lastfm.connected)
        throw new RecordingError("connections_required");
      if (c.lastfm.username !== username)
        throw new RecordingError("account_changed");
      if (!(await this.state()).enabled) {
        // Fetch before enabling. Failure leaves recording paused and preserves the old snapshot.
        await this.app.engine.initializeBaseline();
        await this.store.put("schedule:v1", {
          next_run_ms: this.clock.now() + 180000,
        });
        await this.store.put("recording:v1", {
          enabled: true,
          changed_at: new Date(this.clock.now()).toISOString(),
        });
      }
      await this.arm(true);
      return this.status();
    });
  }
  pause() {
    return this.app.serialize(async () => {
      await this.store.put("recording:v1", {
        enabled: false,
        changed_at: new Date(this.clock.now()).toISOString(),
      });
      await this.arm(false);
      return this.status();
    });
  }
  tick(manual = false) {
    return this.app.serialize(async () => {
      const enabled = (await this.state()).enabled;
      if (!enabled) {
        await this.arm(false);
        return { ok: true, skipped: true, paused: true };
      }
      try {
        if (manual) {
          const run = await this.app.engine.run(true);
          await this.store.put("schedule:v1", {
            next_run_ms: this.clock.now() + 180000,
          });
          return run;
        }
        return await this.app.automaticUnlocked();
      } finally {
        await this.arm(true);
      }
    });
  }
}
