import { expect, it } from "vitest";
import {
  deriveViewModel,
  type Connections,
  type Runtime,
} from "../apps/browser-extension/src/extension-state";

const connections: Connections = {
  apple: { connected: true },
  lastfm: {
    connected: true,
    application_configured: true,
    username: "Listener",
  },
};
const runtime: Runtime = {
  enabled: false,
  algorithm_version: "fixture",
  pending_identity: 0,
  pending_submission: 0,
  stats: { total_scrobbled: 0 },
  records: [],
};
const ready = {
  installed: true,
  verified: true,
  busy: false,
  fresh: true,
  connections,
  runtime,
};

it("starts with the backend step and no recording controls enabled", () => {
  const model = deriveViewModel({
    ...ready,
    installed: false,
    verified: false,
    fresh: false,
    connections: null,
    runtime: null,
  });
  expect(model.nextStep).toBe("cloud");
  expect(model.complete).toEqual({
    cloud: false,
    apple: false,
    lastfm: false,
    confirm: false,
  });
  expect(model.canVisit).toEqual({
    cloud: true,
    apple: false,
    lastfm: false,
    confirm: false,
  });
  expect(model.canStart).toBe(false);
  expect(model.canPause).toBe(false);
});

it("requires backend verification even when installation data and old connections exist", () => {
  const model = deriveViewModel({ ...ready, verified: false });
  expect(model.nextStep).toBe("cloud");
  expect(model.canVisit.apple).toBe(false);
  expect(model.canVisit.lastfm).toBe(false);
  expect(model.canVisit.confirm).toBe(false);
  expect(model.canStart).toBe(false);
});

it("advances through backend, Apple, Last.fm and explicit confirmation", () => {
  expect(deriveViewModel({ ...ready, connections: null }).nextStep).toBe(
    "apple",
  );
  const appleOnly = {
    apple: { connected: true },
    lastfm: { connected: false, application_configured: true },
  };
  const model = deriveViewModel({ ...ready, connections: appleOnly });
  expect(model.nextStep).toBe("lastfm");
  expect(model.complete.lastfm).toBe(false);
  expect(model.canVisit.lastfm).toBe(true);
  expect(model.canVisit.confirm).toBe(false);
  expect(model.canStart).toBe(false);
  expect(deriveViewModel(ready).nextStep).toBe("confirm");
  expect(deriveViewModel(ready).canStart).toBe(true);
  expect(deriveViewModel(ready).complete.confirm).toBe(false);
});

it.each(["busy", "stale"])("blocks mutations with %s state", (condition) => {
  for (const enabled of [false, true]) {
    const model = deriveViewModel({
      ...ready,
      busy: condition === "busy",
      fresh: condition !== "stale",
      runtime: { ...runtime, enabled },
    });
    expect(model.canStart).toBe(false);
    expect(model.canPause).toBe(false);
  }
});

it.each([undefined, "", "   "])(
  "does not start without a confirmed account name (%s)",
  (username) => {
    expect(
      deriveViewModel({
        ...ready,
        connections: { ...connections, lastfm: { connected: true, username } },
      }).canStart,
    ).toBe(false);
  },
);

it("does not guess paused status before runtime has been read", () => {
  const model = deriveViewModel({ ...ready, runtime: null });
  expect(model.canStart).toBe(false);
  expect(model.canPause).toBe(false);
});

it("keeps start disabled after successful start and pause disabled after successful pause", () => {
  const running = deriveViewModel({
    ...ready,
    runtime: { ...runtime, enabled: true },
  });
  expect(running.canStart).toBe(false);
  expect(running.canPause).toBe(true);
  expect(running.complete.confirm).toBe(true);
  const paused = deriveViewModel(ready);
  expect(paused.canPause).toBe(false);
  expect(paused.canStart).toBe(true);
});

it("allows pausing an active backend even when music connections need repair", () => {
  const model = deriveViewModel({
    ...ready,
    connections: null,
    runtime: { ...runtime, enabled: true },
  });
  expect(model.canPause).toBe(true);
  expect(model.canStart).toBe(false);
  expect(model.canVisit.confirm).toBe(false);
});

it.each([
  "queue_account_changed",
  "apple_reconnect_required",
  "lastfm_reconnect_required",
] as const)(
  "requires repairing %s before start but always keeps pause available",
  (code) => {
    const blocked = { ...runtime, recording_issue: { code } };
    expect(deriveViewModel({ ...ready, runtime: blocked }).canStart).toBe(
      false,
    );
    expect(
      deriveViewModel({ ...ready, runtime: { ...blocked, enabled: true } })
        .canPause,
    ).toBe(true);
    expect(
      deriveViewModel({
        ...ready,
        runtime: { ...blocked, recording_issue: null },
      }).canStart,
    ).toBe(true);
  },
);
