import type { Track } from "../../contracts/src/index";
export interface DetectedPlay {
  track: Track;
  kind: "new" | "repeat" | "top-rebound";
}
export interface DetectionState {
  stationaryIdle?: boolean;
  handledCount?: number;
  position0ElapsedSec?: number;
}
export interface DetectionResult {
  plays: DetectedPlay[];
  newState: DetectionState;
}
// General matching behavior preserved from aScrobble 0.3.49.
import { DEFAULT_DURATION_MS, HEAD_OFFSET_SECONDS } from "./constants";
// src/detect.ts
export function detectPlays(
  current: Track[],
  previous: Track[],
  _elapsedSeconds = 180,
  prevState: DetectionState = {},
): DetectionResult {
  if (previous.length === 0) {
    const plays: any = [...current]
      .reverse()
      .map((track?: any) => ({ track, kind: "new" }));
    return {
      plays,
      newState: {
        stationaryIdle: false,
        handledCount: 1,
        position0ElapsedSec: 0,
      },
    };
  }
  const k: any = findShift(current, previous);
  if (k !== null && k > 0) {
    const newPlays: any = [];
    for (let i: any = 0; i < k; i++) {
      newPlays.push({ track: current[i], kind: "new" });
    }
    return {
      plays: newPlays.reverse(),
      newState: {
        stationaryIdle: false,
        handledCount: 1,
        position0ElapsedSec: 0,
      },
    };
  }
  if (
    current.length >= 2 &&
    previous.length >= 2 &&
    current[0].id === previous[0].id
  ) {
    const curTail: any = current.slice(1);
    const prevTail: any = previous.slice(1);
    const tailShift: any = findShift(curTail, prevTail);
    if (tailShift !== null && tailShift > 0) {
      const interimPlays: any = [];
      for (let i: any = 0; i < tailShift; i++) {
        interimPlays.push({ track: curTail[i], kind: "top-rebound" });
      }
      interimPlays.push({ track: current[0], kind: "top-rebound" });
      return {
        plays: interimPlays.reverse(),
        newState: {
          stationaryIdle: false,
          handledCount: (prevState.handledCount ?? 1) + 1,
          position0ElapsedSec: 0,
        },
      };
    }
  }
  if (
    current.length > 0 &&
    previous.length > 0 &&
    current[0].id === previous[0].id
  ) {
    return {
      plays: [],
      newState: {
        stationaryIdle: true,
        handledCount: prevState.handledCount ?? 1,
        position0ElapsedSec: 0,
      },
    };
  }
  const fallback: any = fallbackDetect(current, previous);
  return {
    plays: fallback,
    newState: {
      stationaryIdle: false,
      handledCount: 1,
      position0ElapsedSec: 0,
    },
  };
}
export function findShift(current: Track[], previous: Track[]): number | null {
  const curLen: any = current.length;
  const prevLen: any = previous.length;
  for (let k: any = 0; k < curLen; k++) {
    const suffixLen: any = curLen - k;
    if (suffixLen > prevLen) continue;
    let match: any = true;
    for (let i: any = 0; i < suffixLen; i++) {
      if (current[k + i].id !== previous[i].id) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return null;
}
export function fallbackDetect(
  current: Track[],
  previous: Track[],
): DetectedPlay[] {
  const previousIds: any = new Set(previous.map((track?: any) => track.id));
  const detected: any = [];
  for (const track of current) {
    if (previousIds.has(track.id)) break;
    detected.push({ track, kind: "new" });
  }
  return detected.reverse();
}
export function filterImplausibleInferredRepeats(
  plays: DetectedPlay[],
  elapsedSeconds: number,
): { plays: DetectedPlay[]; dropped: number } {
  const inferred: any = plays.filter(
    (play?: any) => play.kind === "repeat" || play.kind === "top-rebound",
  );
  if (inferred.length === 0) return { plays, dropped: 0 };
  const minimumListeningSeconds: any = inferred.reduce(
    (sum?: any, play?: any) => {
      const durationSeconds: any =
        Number(play.track?.duration_ms ?? DEFAULT_DURATION_MS) / 1e3;
      return sum + Math.min(Math.max(durationSeconds / 2, 30), 240);
    },
    0,
  );
  const plausibleWindowSeconds: any =
    Math.max(Number(elapsedSeconds ?? 0), 0) + 60;
  if (minimumListeningSeconds <= plausibleWindowSeconds)
    return { plays, dropped: 0 };
  const safePlays: any = plays.filter(
    (play?: any) => play.kind !== "repeat" && play.kind !== "top-rebound",
  );
  return { plays: safePlays, dropped: plays.length - safePlays.length };
}
export function assignTimestamps(
  plays: DetectedPlay[],
  runTime: Date,
  lastRunTime?: Date | null,
): Array<DetectedPlay & { timestamp: Date }> {
  if (plays.length === 0) return [];
  const floor: any =
    lastRunTime ?? new Date(runTime.getTime() - 6 * 60 * 60 * 1e3);
  const windowSeconds: any = Math.max(
    1,
    (runTime.getTime() - floor.getTime()) / 1e3 - HEAD_OFFSET_SECONDS,
  );
  const totalDurationSeconds: any = plays.reduce(
    (sum?: any, p?: any) =>
      sum + (p.track.duration_ms || DEFAULT_DURATION_MS) / 1e3,
    0,
  );
  const scale: any =
    totalDurationSeconds > windowSeconds
      ? windowSeconds / totalDurationSeconds
      : 1;
  let cumulative: any = HEAD_OFFSET_SECONDS;
  const reversed: any = [];
  for (let i: any = plays.length - 1; i >= 0; i--) {
    const play: any = plays[i];
    const durationSeconds: any =
      ((play.track.duration_ms || DEFAULT_DURATION_MS) / 1e3) * scale;
    const timestamp: any = new Date(
      runTime.getTime() - (cumulative + durationSeconds) * 1e3,
    );
    cumulative += durationSeconds;
    reversed.push({ ...play, timestamp });
  }
  return reversed.reverse();
}
