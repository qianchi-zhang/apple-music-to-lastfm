import { systemClock } from "../../../packages/contracts/src/index";
import { CoordinatedKvStore } from "../../../packages/storage/src/index";
import {
  createServices,
  type Credentials,
} from "../../../packages/providers/src/services";
import { Application, json } from "./application";
import {
  LastfmAuthorization,
  lastfmExtensionResultPage,
  lastfmExtensionRoutes,
} from "./lastfm-connection";
import { setupCookie, validSetupSession } from "./setup-session";
import { Recording, RecordingError } from "./recording";
import { deploymentInfo, type DeploymentMetadata } from "./deployment";
import { setupPage } from "./setup-page";
export interface Env extends Credentials, DeploymentMetadata {
  ASCROBBLE_STATE: KVNamespace;
  SCROBBLE_COORDINATOR: DurableObjectNamespace;
  STATUS_AUTH_KEY: string;
}
export class ScrobbleCoordinator {
  private app: Application;
  private lastfm: LastfmAuthorization;
  private recording: Recording;
  constructor(
    private state: DurableObjectState,
    env: Env,
  ) {
    const store = new CoordinatedKvStore(env.ASCROBBLE_STATE, state.storage);
    this.lastfm = new LastfmAuthorization(store, systemClock, env);
    this.app = new Application({
      store,
      kv: env.ASCROBBLE_STATE,
      services: createServices(env.ASCROBBLE_STATE, env, {
        credentialStore: store,
      }),
      clock: systemClock,
    });
    this.recording = new Recording(
      this.app,
      store,
      state.storage,
      systemClock,
      async () => (await this.lastfm.status()).json(),
    );
    // Reads must remain reads: scheduling is bootstrapped by Cron, not a GET.
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/connections" && request.method === "GET")
      return this.app.serialize(() => this.lastfm.status());
    if (path === "/api/v1/recording" && request.method === "GET")
      return json(await this.recording.status());
    if (
      request.method === "POST" &&
      ["/api/v1/recording/start", "/api/v1/recording/pause"].includes(path)
    ) {
      try {
        if (path.endsWith("/pause")) return json(await this.recording.pause());
        const body = (await request.json().catch(() => null)) as {
          username?: unknown;
        } | null;
        if (
          !body ||
          typeof body.username !== "string" ||
          Object.keys(body).length !== 1
        )
          return json({ error: "invalid_request" }, 400);
        return json(await this.recording.start(body.username));
      } catch (error) {
        return json(
          {
            error:
              error instanceof RecordingError
                ? error.code
                : "recording_control_failed",
          },
          error instanceof RecordingError ? error.status : 503,
        );
      }
    }
    if (path === "/trigger" && request.method === "POST") {
      const run = await this.recording.tick(true);
      return json({ ok: run.ok, run, ledger: await this.app.engine.status() });
    }
    const action =
      path === "/api/v1/connections/lastfm/application" &&
      request.method === "PUT"
        ? () => this.lastfm.configure(request)
        : path === "/api/v1/connections/lastfm/start" &&
            request.method === "POST"
          ? () => this.lastfm.start(request)
          : path === lastfmExtensionRoutes.start && request.method === "POST"
            ? () => this.lastfm.start(request, "extension")
            : path === lastfmExtensionRoutes.authorize &&
                request.method === "GET"
              ? () => this.lastfm.authorizeExtension(request)
              : path === "/api/v1/connections/lastfm/callback" &&
                  request.method === "GET"
                ? () => this.lastfm.callback(request)
                : null;
    if (action)
      return this.app
        .serialize(action)
        .catch(() => json({ error: "connection_failed" }, 503));
    if (
      new URL(request.url).pathname === "/internal/automatic" &&
      request.method === "POST"
    ) {
      const result = await this.recording.tick();
      return json(result);
    }
    return this.app.handle(request);
  }
  async alarm() {
    await this.recording.tick();
  }
}
function stub(env: Env) {
  return env.SCROBBLE_COORDINATOR.get(
    env.SCROBBLE_COORDINATOR.idFromName("global-scrobble-coordinator"),
  );
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if ((path === "/" || path === "/setup") && request.method === "GET")
      return setupPage();
    if (path === lastfmExtensionRoutes.result && request.method === "GET")
      return lastfmExtensionResultPage(request);
    if (path === "/health" && request.method === "GET")
      return json({
        ok: true,
        service: "apple-music-scrobbler",
        version: "0.1.0",
        baseline: "0.3.49",
        capabilities: { lastfm_extension_auth: true },
      });
    if (path.startsWith("/internal/")) return json({ error: "not found" }, 404);
    if (!env.STATUS_AUTH_KEY)
      return json({ error: "management key not configured" }, 503);
    const headerAuth =
      request.headers.get("x-ascrobble-auth") === env.STATUS_AUTH_KEY;
    const origin = new URL(request.url).origin;
    if (path === "/api/v1/setup/session" && request.method === "POST") {
      if (!headerAuth) return json({ error: "unauthorized" }, 401);
      if (
        request.headers.get("Origin") !== origin ||
        !origin.startsWith("https://")
      )
        return json({ error: "invalid_origin" }, 403);
      const response = json({ ok: true });
      response.headers.set(
        "Set-Cookie",
        await setupCookie(env.STATUS_AUTH_KEY),
      );
      return response;
    }
    const setupRoute =
      (path === "/api/v1/deployment" && request.method === "GET") ||
      (path === "/api/v1/recording" && request.method === "GET") ||
      (["/api/v1/recording/start", "/api/v1/recording/pause"].includes(path) &&
        request.method === "POST") ||
      (path === "/api/v1/connections" && request.method === "GET") ||
      (path === "/api/v1/connections/lastfm/application" &&
        request.method === "PUT") ||
      (path === "/api/v1/connections/lastfm/start" &&
        request.method === "POST");
    const callback =
      (path === "/api/v1/connections/lastfm/callback" ||
        path === lastfmExtensionRoutes.authorize) &&
      request.method === "GET";
    const sessionAuth =
      setupRoute &&
      (await validSetupSession(request, env.STATUS_AUTH_KEY)) &&
      (request.method === "GET" || request.headers.get("Origin") === origin);
    if (!headerAuth && !sessionAuth && !callback)
      return json({ error: "unauthorized" }, 401);
    if (path === "/api/v1/deployment" && request.method === "GET")
      return json(deploymentInfo(env));
    if (!env.SCROBBLE_COORDINATOR)
      return json({ error: "coordinator binding required" }, 503);
    return stub(env).fetch(request);
  },
  async scheduled(_event: ScheduledController, env: Env) {
    const response = await stub(env).fetch(
      "https://coordinator.internal/internal/automatic",
      { method: "POST" },
    );
    if (!response.ok) throw new Error("scheduled dispatch failed");
  },
} satisfies ExportedHandler<Env>;
