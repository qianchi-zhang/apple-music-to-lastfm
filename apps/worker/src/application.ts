import { parseAppleCredentials } from "../../../packages/contracts/src/apple-credentials";
import type {
  Clock,
  JsonStore,
  RawKv,
  Services,
} from "../../../packages/contracts/src/index";
import { Engine } from "../../../packages/core/src/engine";
import {
  ProfileRepository,
  ProfileError,
  applyProfile,
  validateProfile,
  validateResolvedTrack,
} from "../../../packages/profiles/src/index";
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
export class Application {
  private queue: Promise<unknown> = Promise.resolve();
  readonly profiles: ProfileRepository;
  readonly engine: Engine;
  constructor(
    private deps: {
      store: JsonStore;
      services: Services;
      clock: Clock;
      kv?: RawKv;
      capacity?: number;
    },
  ) {
    this.profiles = new ProfileRepository(deps.store);
    this.engine = new Engine({ ...deps, profile: () => this.profiles.get() });
  }
  serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.catch(() => undefined).then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async automatic() {
    return this.serialize(() => this.automaticUnlocked());
  }
  /** Caller must hold the application serialization queue. */
  async automaticUnlocked() {
    const now = this.deps.clock.now();
    const schedule = await this.deps.store.get<{ next_run_ms: number }>(
      "schedule:v1",
    );
    if (schedule && schedule.next_run_ms > now)
      return { ok: true, skipped: true };
    await this.deps.store.put("schedule:v1", { next_run_ms: now + 180000 });
    const result = await this.engine.run();
    await this.deps.store.put("schedule:v1", {
      next_run_ms: this.deps.clock.now() + 180000,
    });
    return result;
  }
  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/health")
        return json({
          ok: true,
          service: "apple-music-scrobbler",
          version: "0.1.0",
          baseline: "0.3.49",
        });
      if (path === "/api/v1/profile" && request.method === "GET")
        return json(await this.profiles.get());
      if (path === "/status" && request.method === "GET")
        return json(await this.engine.status());
      if (path === "/automation-status" && request.method === "GET")
        return json({
          interval_seconds: 180,
          ...(await this.deps.store.get<Record<string, unknown>>(
            "schedule:v1",
          )),
        });
      if (path === "/api/v1/profile" && request.method === "PUT")
        return await this.serialize(async () =>
          json(await this.profiles.replace(await request.json())),
        );
      if (path === "/api/v1/profile/validate" && request.method === "POST") {
        const errors = validateProfile(await request.json());
        return json(
          { ok: errors.length === 0, errors },
          errors.length ? 400 : 200,
        );
      }
      if (path === "/api/v1/profile/preview" && request.method === "POST") {
        const body = (await request.json()) as {
          profile: unknown;
          track: unknown;
        };
        const errors = validateProfile(body?.profile);
        if (errors.length || !validateResolvedTrack(body?.track))
          return json({ error: "invalid preview input", errors }, 400);
        return json(
          applyProfile(
            body.track,
            body.profile as import("../../../packages/contracts/src/index").UserProfile,
          ),
        );
      }
      if (path === "/trigger" && request.method === "POST")
        return await this.serialize(async () => {
          const run = await this.engine.run(true);
          await this.deps.store.put("schedule:v1", {
            next_run_ms: this.deps.clock.now() + 180000,
          });
          return json({
            ok: run.ok,
            triggered: true,
            run,
            ledger: await this.engine.status(),
          });
        });
      if (path === "/recover-exact-tracks" && request.method === "POST")
        return await this.serialize(async () => {
          const body = (await request.json()) as {
            items: unknown;
            dry_run?: boolean;
          };
          const recovery = await this.engine.recover(
            body.items,
            body.dry_run !== false,
          );
          if (body.dry_run !== false) return json(recovery);
          return json({ ...recovery, run: await this.engine.run(true) });
        });
      if (path === "/reset-stats" && request.method === "POST")
        return await this.serialize(async () => {
          const ledger = await this.engine.status();
          ledger.stats.total_errors = 0;
          ledger.stats.last_error_iso = null;
          ledger.stats.last_error_message = null;
          ledger.consecutive_errors = 0;
          delete ledger.circuit_open_until_iso;
          await this.deps.store.put("ledger:v1", ledger);
          return json(ledger);
        });
      if (path === "/clear-cache" && request.method === "POST")
        return await this.serialize(async () => {
          const opts = (await request.json().catch(() => ({}))) as Record<
            string,
            boolean
          >;
          const ledger = await this.engine.status();
          if (opts.clear_snapshot !== false) {
            ledger.previous_recent = [];
            ledger.stationary_idle = false;
            ledger.handled_count = 0;
            delete ledger.top_track_id;
            delete ledger.top_track_play_count;
          }
          if (opts.clear_dedup !== false) ledger.recent_scrobble_ids = [];
          if (opts.clear_logs) ledger.log_entries = [];
          if (opts.clear_recent) ledger.recent_scrobbles = [];
          if (opts.clear_circuit !== false) {
            ledger.consecutive_errors = 0;
            delete ledger.circuit_open_until_iso;
            ledger.stats.last_error_message = null;
          }
          await this.deps.store.put("ledger:v1", ledger);
          return json({ ok: true, ledger });
        });
      if (path === "/api/v1/connections/apple" && request.method === "POST")
        return await this.serialize(async () => {
          // Do not expose provider errors or credentials in responses/logs.
          const text = await request.text();
          if (text.length > 40000)
            return json({ error: "invalid_credentials" }, 400);
          let candidate: unknown;
          try {
            candidate = JSON.parse(text);
          } catch {
            return json({ error: "invalid_credentials" }, 400);
          }
          const credentials = parseAppleCredentials(candidate);
          if (!credentials) return json({ error: "invalid_credentials" }, 400);
          if (!this.deps.services.verifyApple)
            return json({ error: "verification_unavailable" }, 503);
          const result = await this.deps.services
            .verifyApple(credentials)
            .catch(() => ({ ok: false, code: "apple_unavailable" as const }));
          if (!result.ok)
            return json(
              { error: result.code },
              result.code === "apple_rejected" ? 422 : 502,
            );
          try {
            // One durable write replaces both tokens only after verification.
            await this.deps.store.put("apple-connection:v1", credentials);
          } catch {
            return json({ error: "save_failed" }, 503);
          }
          return json({ ok: true, connected: true, verified: true });
        });
      if (path === "/update-tokens" && request.method === "POST")
        return await this.serialize(async () => {
          const body = (await request.json()) as Record<string, unknown>;
          const updated: string[] = [];
          for (const field of ["apple_dev_token", "apple_user_token"])
            if (
              body[field] !== undefined &&
              (typeof body[field] !== "string" || !body[field])
            )
              return json({ error: "invalid token value" }, 400);
          if (!this.deps.kv)
            return json({ error: "token storage unavailable" }, 503);
          for (const field of ["apple_dev_token", "apple_user_token"])
            if (body[field]) {
              await this.deps.kv.put(field, body[field] as string);
              updated.push(field);
            }
          const connection = await this.deps.store.get<
            import("../../../packages/contracts/src/index").AppleCredentials
          >("apple-connection:v1");
          if (connection)
            await this.deps.store.put("apple-connection:v1", {
              apple_dev_token:
                body.apple_dev_token ?? connection.apple_dev_token,
              apple_user_token:
                body.apple_user_token ?? connection.apple_user_token,
            });
          const ledger = await this.engine.status();
          ledger.consecutive_errors = 0;
          delete ledger.circuit_open_until_iso;
          ledger.stats.last_error_message = null;
          await this.deps.store.put("ledger:v1", ledger);
          return json({ ok: true, updated });
        });
      if (
        path === "/acknowledge-migration-recovery" &&
        request.method === "POST"
      )
        return await this.serialize(async () => {
          await this.deps.store.put("migration-recovery:acknowledged", true);
          return json({ ok: true });
        });
      if (path === "/recover-migration" && request.method === "POST")
        return json(
          {
            error:
              "Use offline ledger migration and /recover-exact-tracks with an explicit preview; implicit timestamp reconstruction is not supported",
          },
          409,
        );
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        error instanceof ProfileError
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : 400,
      );
    }
  }
}
