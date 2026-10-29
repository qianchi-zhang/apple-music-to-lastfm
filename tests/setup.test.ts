import { describe, expect, it } from "vitest";
import {
  deploymentConfig,
  selectNamespace,
  validateDeployment,
} from "../scripts/setup-model";
const state = {
  accountId: "a".repeat(32),
  workerName: "apple-music-scrobbler-123456abcdef",
  namespaceId: "b".repeat(32),
};
describe("personal deployment boundaries", () => {
  it("uses only the selected account and own namespace; schedules stay disabled", () => {
    const config = deploymentConfig(validateDeployment(state));
    expect(config.account_id).toBe(state.accountId);
    expect(config.kv_namespaces).toEqual([
      { binding: "ASCROBBLE_STATE", id: state.namespaceId },
    ]);
    expect(config.triggers.crons).toEqual([]);
    expect(config.main).toBe("dist/worker.js");
    expect(config.no_bundle).toBe(true);
  });
  it("rejects corrupted or legacy production targets", () => {
    for (const value of [
      null,
      {},
      { ...state, workerName: "ascrobble" },
      { ...state, accountId: "wrong" },
      { ...state, namespaceId: "wrong" },
    ])
      expect(() => validateDeployment(value)).toThrow();
  });
  it("recovers a created namespace by exact saved name and fails on ambiguity", () => {
    const title = state.workerName + "-state";
    expect(
      selectNamespace([{ title: "other", id: state.namespaceId }], title),
    ).toBeUndefined();
    const entry = { title, id: state.namespaceId };
    expect(selectNamespace([entry], title)).toEqual({ id: state.namespaceId });
    expect(() => selectNamespace([entry, entry], title)).toThrow();
    expect(() => selectNamespace([{ title, id: "wrong" }], title)).toThrow();
    expect(() => selectNamespace({}, title)).toThrow();
  });
});

it("dry run is noninteractive and does not create local deployment files", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const files = [
    "deployment.local.json",
    ".dev.vars.personal",
    "wrangler.personal.local.json",
    ".setup-lock",
  ];
  const before = files.map(existsSync);
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/setup.ts", "--dry-run"],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(output).toContain("不会读取登录凭据");
  expect(output).toContain('"crons": []');
  expect(files.map(existsSync)).toEqual(before);
});
