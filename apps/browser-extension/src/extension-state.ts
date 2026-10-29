import { recordingIssue, type RecordingIssue } from "./recording-issue";

export type Step = "cloud" | "apple" | "lastfm" | "confirm";

export interface Connections {
  apple: { connected: boolean };
  lastfm: {
    connected: boolean;
    application_configured?: boolean;
    username?: string;
  };
}

export interface Runtime {
  recording_issue?: RecordingIssue | null;
  enabled: boolean;
  algorithm_version: string;
  algorithm_sha256?: string;
  last_run_iso?: string | null;
  next_run_ms?: number | null;
  pending_identity: number;
  pending_submission: number;
  stats: {
    total_scrobbled: number;
    last_error_message?: string | null;
    [key: string]: unknown;
  };
  records: Array<{
    artist: string;
    track: string;
    album?: string;
    status?: string;
    timestamp_iso?: string;
    [key: string]: unknown;
  }>;
}

interface ViewState {
  installed: boolean;
  verified: boolean;
  busy: boolean;
  fresh: boolean;
  connections: Connections | null;
  runtime: Runtime | null;
}

/** The only source of action eligibility; finishing a request cannot enable it. */
export function deriveViewModel(state: ViewState): {
  nextStep: Step;
  canStart: boolean;
  canPause: boolean;
  complete: Record<Step, boolean>;
  canVisit: Record<Step, boolean>;
} {
  const cloud = state.installed && state.verified;
  const apple = cloud && state.connections?.apple.connected === true;
  const lastfm = cloud && state.connections?.lastfm.connected === true;
  const connected = apple && lastfm;
  const canChange = cloud && state.fresh && !state.busy;
  const username = state.connections?.lastfm.username?.trim();
  const issue = recordingIssue(state.runtime);
  const requiresRepair =
    issue &&
    [
      "queue_account_changed",
      "apple_reconnect_required",
      "lastfm_reconnect_required",
    ].includes(issue.code);

  return {
    nextStep: !cloud
      ? "cloud"
      : !apple
        ? "apple"
        : !lastfm
          ? "lastfm"
          : "confirm",
    canStart:
      canChange &&
      connected &&
      !!username &&
      !requiresRepair &&
      state.runtime !== null &&
      !state.runtime.enabled,
    // A broken music connection must not prevent stopping the background service.
    canPause: canChange && state.runtime?.enabled === true,
    complete: {
      cloud,
      apple,
      lastfm,
      confirm: connected && state.runtime?.enabled === true,
    },
    canVisit: { cloud: true, apple: cloud, lastfm: cloud, confirm: connected },
  };
}
