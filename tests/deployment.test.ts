import { it, expect } from "vitest";
import { deploymentInfo } from "../apps/worker/src/deployment";
import worker, { type Env } from "../apps/worker/src/index";
import { setupCookie } from "../apps/worker/src/setup-session";
it("constructs only official Cloudflare links and never claims account management access", () => {
  const info = deploymentInfo({
    DEPLOYMENT_ACCOUNT_ID: "a".repeat(32),
    DEPLOYMENT_WORKER_NAME: "scrobbler-test",
  });
  expect(info.dashboard_url).toBe(
    "https://dash.cloudflare.com/" +
      "a".repeat(32) +
      "/workers/services/view/scrobbler-test/production",
  );
  expect(info.account_management_authorized).toBe(false);
  expect(
    deploymentInfo({
      DEPLOYMENT_ACCOUNT_ID: "evil.test",
      DEPLOYMENT_WORKER_NAME: "../../redirect",
    }).dashboard_url,
  ).toBe("https://dash.cloudflare.com/");
});
it("deployment metadata requires header or scoped session and contains no credentials", async () => {
  const env = {
    STATUS_AUTH_KEY: "private-test-secret",
    DEPLOYMENT_WORKER_NAME: "scrobbler-test",
  } as Env;
  const url = "https://example.test/api/v1/deployment";
  expect((await worker.fetch(new Request(url), env)).status).toBe(401);
  const cookie = (await setupCookie(env.STATUS_AUTH_KEY)).split(";")[0];
  const res = await worker.fetch(
    new Request(url, { headers: { Cookie: cookie } }),
    env,
  );
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("scrobbler-test");
  expect(body).not.toContain(env.STATUS_AUTH_KEY);
});
