import { it, expect } from "vitest";
import {
  Cloudflare,
  CloudflareError,
  validateInstall,
  type InstallState,
} from "../apps/browser-extension/src/cloudflare";
const initial: InstallState = {
  account: "a".repeat(32),
  name: "ams-" + "b".repeat(24),
  marker: "c".repeat(32),
  key: "d".repeat(64),
};
function harness(existing = false, foreign = false) {
  let namespace = false,
    uploaded = existing,
    subdomain = "example";
  const calls: { url: string; method: string; body: any }[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = String(url);
    calls.push({ url: path, method: init?.method || "GET", body: init?.body });
    expect(path.startsWith("https://api.cloudflare.com/client/v4/")).toBe(true);
    expect(init?.redirect).toBe("error");
    if (path.endsWith("/workers/subdomain"))
      return Response.json({ success: true, result: { subdomain } });
    if (path.endsWith("/settings"))
      return uploaded
        ? Response.json({
            success: true,
            result: {
              bindings: [
                { name: "INSTALLER_ALGORITHM", text: "0.3.111" },
                {
                  name: "INSTALLATION_ID",
                  text: foreign ? "other" : initial.marker,
                },
              ],
            },
          })
        : new Response("", { status: 404 });
    if (path.includes("/storage/kv/namespaces?"))
      return Response.json({
        success: true,
        result: namespace
          ? [{ id: "e".repeat(32), title: initial.name + "-state" }]
          : [],
      });
    if (path.endsWith("/storage/kv/namespaces")) {
      namespace = true;
      return Response.json({ success: true, result: { id: "e".repeat(32) } });
    }
    if (init?.method === "PUT") {
      uploaded = true;
      const form = init.body as FormData;
      const meta = JSON.parse(form.get("metadata") as string);
      expect(
        meta.bindings.some(
          (b: any) => b.type === "secret_text" && b.text === initial.key,
        ),
      ).toBe(true);
      expect(meta.migrations.steps[0].new_sqlite_classes).toEqual([
        "ScrobbleCoordinator",
      ]);
      expect(meta.bindings).toContainEqual({
        type: "plain_text",
        name: "INSTALLER_ALGORITHM",
        text: "0.3.111",
      });
    }
    return Response.json({ success: true, result: {} });
  };
  return {
    client: new Cloudflare("test-token-".repeat(4), request),
    calls,
    setSubdomain(value: string) {
      subdomain = value;
    },
  };
}
it("prepares an account's exact host with a read-only subdomain lookup", async () => {
  const h = harness();
  await expect(h.client.subdomain(initial.account)).resolves.toBe("example");
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]).toMatchObject({
    method: "GET",
    url:
      "https://api.cloudflare.com/client/v4/accounts/" +
      initial.account +
      "/workers/subdomain",
  });
});
it("requires a valid deployment account and configured subdomain before any writes", async () => {
  const h = harness();
  await expect(h.client.subdomain("../other")).rejects.toMatchObject({
    code: "accounts_invalid",
  });
  expect(h.calls).toHaveLength(0);
  h.setSubdomain("");
  await expect(h.client.subdomain(initial.account)).rejects.toThrow(
    "设置 workers.dev 子域名",
  );
  expect(h.calls.every((call) => call.method === "GET")).toBe(true);
});
it("rechecks a prepared host and stops a changed domain before storage or Worker writes", async () => {
  const h = harness();
  const domain = await h.client.subdomain(initial.account);
  const expectedOrigin =
    "https://" + initial.name + "." + domain + ".workers.dev";
  h.setSubdomain("changed");
  let saves = 0;
  await expect(
    h.client.install(
      initial,
      "code",
      async () => {
        saves++;
      },
      () => {},
      expectedOrigin,
    ),
  ).rejects.toThrow("deployment_origin_changed");
  expect(saves).toBe(0);
  expect(h.calls).toHaveLength(2);
  expect(h.calls.every((call) => call.method === "GET")).toBe(true);
});
it("installs directly at the previously authorized exact origin", async () => {
  const h = harness();
  const domain = await h.client.subdomain(initial.account);
  const expectedOrigin =
    "https://" + initial.name + "." + domain + ".workers.dev";
  const result = await h.client.install(
    initial,
    "export default {}",
    async () => {},
    () => {},
    expectedOrigin,
  );
  expect(result.origin).toBe(expectedOrigin);
  expect(h.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});
it("installs once, resumes without uploading again and never schedules recording", async () => {
  const h = harness();
  let saved = { ...initial };
  const save = async (s: InstallState) => {
    saved = { ...s };
  };
  await h.client.install(saved, "export default {}", save, () => {});
  expect(saved.origin).toBe("https://" + initial.name + ".example.workers.dev");
  await h.client.install(saved, "export default {}", save, () => {});
  expect(h.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  expect(
    h.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/storage/kv/namespaces"),
    ),
  ).toHaveLength(1);
  expect(
    h.calls.some((c) => c.url.includes("schedules") || c.method === "DELETE"),
  ).toBe(false);
});
it("refuses another installation before any writes", async () => {
  const h = harness(true, true);
  await expect(
    h.client.install(
      initial,
      "code",
      async () => {},
      () => {},
    ),
  ).rejects.toThrow("不属于");
  expect(h.calls.every((c) => c.method === "GET")).toBe(true);
});
it("validates persisted destinations and refuses credentials sent to arbitrary origins", () => {
  expect(() =>
    validateInstall({ ...initial, origin: "https://evil.test" }),
  ).toThrow();
  expect(() =>
    validateInstall({ ...initial, account: "../../other" }),
  ).toThrow();
  expect(() => new Cloudflare("invalid token")).toThrow();
});
it("keeps a KV created before interrupted save discoverable on retry", async () => {
  const h = harness();
  let first = true;
  await expect(
    h.client.install(
      initial,
      "code",
      async () => {
        if (first) {
          first = false;
          throw Error("storage failed");
        }
      },
      () => {},
    ),
  ).rejects.toThrow("storage failed");
  await h.client.install(
    initial,
    "code",
    async () => {},
    () => {},
  );
  expect(
    h.calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/storage/kv/namespaces"),
    ),
  ).toHaveLength(1);
});

const installed: InstallState = {
  ...initial,
  namespace: "e".repeat(32),
  origin: "https://" + initial.name + ".example.workers.dev",
};
function updateSettings() {
  return {
    compatibility_date: "2026-09-08",
    compatibility_flags: ["no_global_navigator"],
    logpush: false,
    observability: { enabled: false },
    tags: ["existing-tag"],
    limits: { cpu_ms: 50 },
    bindings: [
      { type: "plain_text", name: "INSTALLATION_ID", text: initial.marker },
      { type: "plain_text", name: "INSTALLER_ALGORITHM", text: "0.3.111" },
      {
        type: "plain_text",
        name: "DEPLOYMENT_ACCOUNT_ID",
        text: initial.account,
      },
      {
        type: "plain_text",
        name: "DEPLOYMENT_WORKER_NAME",
        text: initial.name,
      },
      { type: "secret_text", name: "STATUS_AUTH_KEY" },
      {
        type: "kv_namespace",
        name: "ASCROBBLE_STATE",
        namespace_id: installed.namespace,
      },
      {
        type: "durable_object_namespace",
        name: "SCROBBLE_COORDINATOR",
        class_name: "ScrobbleCoordinator",
        namespace_id: "ffffeeee-dddd-cccc-bbbb-aaaaaaaaaaaa",
      },
      { type: "secret_text", name: "EXISTING_EXTRA_SECRET" },
    ] as Array<Record<string, any>>,
  };
}
function updateHarness(
  settings: unknown = updateSettings(),
  upload?: Response,
) {
  const calls: { url: string; method: string; body: any }[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = String(url);
    calls.push({ url: path, method: init?.method || "GET", body: init?.body });
    expect(path.startsWith("https://api.cloudflare.com/client/v4/")).toBe(true);
    expect(init?.redirect).toBe("error");
    if (path.endsWith("/settings"))
      return settings === null
        ? new Response("", { status: 404 })
        : Response.json({ success: true, result: settings });
    if (init?.method === "PUT")
      return upload ?? Response.json({ success: true, result: {} });
    throw Error("Unexpected update request");
  };
  return { client: new Cloudflare("test-token-".repeat(4), request), calls };
}

it("updates only the owned Worker code and release marker while strictly inheriting its other bindings", async () => {
  const settings = updateSettings();
  const h = updateHarness(settings);
  const input = { ...installed };
  const progress: string[] = [];
  await h.client.update(input, "export default { fetch() {} }", (message) =>
    progress.push(message),
  );
  expect(input).toEqual(installed);
  expect(h.calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
  expect(h.calls[1].url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/" +
      installed.account +
      "/workers/scripts/" +
      installed.name +
      "?bindings_inherit=strict",
  );
  const form = h.calls[1].body as FormData;
  const metadata = JSON.parse(form.get("metadata") as string);
  expect(metadata).toEqual({
    main_module: "worker.js",
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    keep_assets: true,
    logpush: settings.logpush,
    observability: settings.observability,
    tags: settings.tags,
    limits: settings.limits,
    bindings: settings.bindings.map(({ name }) =>
      name === "INSTALLER_ALGORITHM"
        ? { name, type: "plain_text", text: "0.3.111" }
        : { name, type: "inherit" },
    ),
  });
  expect(metadata).not.toHaveProperty("migrations");
  expect(metadata).not.toHaveProperty("exports");
  expect(JSON.stringify(metadata)).not.toContain(installed.key);
  expect(JSON.stringify(metadata)).not.toContain(installed.namespace);
  expect(await (form.get("worker.js") as Blob).text()).toBe(
    "export default { fetch() {} }",
  );
  expect(
    h.calls.some((call) => /storage\/|schedules|subdomain/.test(call.url)),
  ).toBe(false);
  expect(progress).toHaveLength(2);
});

it("accepts the original self-source DO binding with an undashed namespace ID", async () => {
  const settings = updateSettings();
  const coordinator = settings.bindings.find(
    (binding) => binding.name === "SCROBBLE_COORDINATOR",
  )!;
  Object.assign(coordinator, {
    script_name: installed.name,
    environment: "production",
    namespace_id: "f".repeat(32),
  });
  const h = updateHarness(settings);
  await h.client.update(installed, "code", () => {});
  expect(h.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

it("upgrades an owned 0.3.106 installation in place while preserving every private and storage binding", async () => {
  const settings = updateSettings();
  settings.bindings.find(
    (binding) => binding.name === "INSTALLER_ALGORITHM",
  )!.text = "0.3.106";
  const h = updateHarness(settings);
  await h.client.update(installed, "new frozen release", () => {});
  expect(h.calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
  const form = h.calls[1].body as FormData;
  const metadata = JSON.parse(String(form.get("metadata")));
  expect(metadata.bindings).toEqual(
    settings.bindings.map(({ name }) =>
      name === "INSTALLER_ALGORITHM"
        ? { name, type: "plain_text", text: "0.3.111" }
        : { name, type: "inherit" },
    ),
  );
  expect(metadata).not.toHaveProperty("migrations");
  expect(JSON.stringify(metadata)).not.toContain(installed.key);
  expect(JSON.stringify(metadata)).not.toContain(installed.namespace);
});

it("does not permit an old algorithm marker through the installation recovery path", async () => {
  const request: typeof fetch = async (url) =>
    String(url).endsWith("/workers/subdomain")
      ? Response.json({ success: true, result: { subdomain: "example" } })
      : Response.json({
          success: true,
          result: {
            bindings: [
              { name: "INSTALLATION_ID", text: initial.marker },
              { name: "INSTALLER_ALGORITHM", text: "0.3.106" },
            ],
          },
        });
  const client = new Cloudflare("test-token-".repeat(4), request);
  await expect(
    client.install(
      initial,
      "new frozen release",
      async () => {},
      () => {},
    ),
  ).rejects.toThrow("已有实例使用旧算法");
});

it.each(["namespace", "origin"] as const)(
  "refuses an incomplete installation missing %s without API calls",
  async (field) => {
    const h = updateHarness();
    const input = { ...installed };
    delete input[field];
    await expect(h.client.update(input, "code", () => {})).rejects.toThrow(
      "backend_update_missing",
    );
    expect(h.calls).toEqual([]);
  },
);

it("refuses a missing remote Worker and never recreates it", async () => {
  const h = updateHarness(null);
  await expect(h.client.update(installed, "code", () => {})).rejects.toThrow(
    "backend_update_missing",
  );
  expect(h.calls.map((call) => call.method)).toEqual(["GET"]);
});

it("refuses an empty update payload before reading or writing the account", async () => {
  const h = updateHarness();
  await expect(h.client.update(installed, " \n", () => {})).rejects.toThrow(
    "missing_asset",
  );
  expect(h.calls).toEqual([]);
});

it.each([
  ["INSTALLATION_ID", "text", "foreign-marker"],
  ["INSTALLATION_ID", "type", "secret_text"],
  ["INSTALLER_ALGORITHM", "text", "0.3.105"],
  ["INSTALLER_ALGORITHM", "text", "0.3.110"],
  ["INSTALLER_ALGORITHM", "text", "0.3.112"],
  ["DEPLOYMENT_ACCOUNT_ID", "text", "f".repeat(32)],
  ["DEPLOYMENT_WORKER_NAME", "text", "another-worker"],
  ["STATUS_AUTH_KEY", "type", "plain_text"],
  ["ASCROBBLE_STATE", "type", "plain_text"],
  ["ASCROBBLE_STATE", "namespace_id", "f".repeat(32)],
  ["SCROBBLE_COORDINATOR", "type", "kv_namespace"],
  ["SCROBBLE_COORDINATOR", "class_name", "AnotherCoordinator"],
  ["SCROBBLE_COORDINATOR", "namespace_id", ""],
  ["SCROBBLE_COORDINATOR", "namespace_id", undefined],
  ["SCROBBLE_COORDINATOR", "script_name", "another-worker"],
  ["SCROBBLE_COORDINATOR", "environment", "staging"],
  ["SCROBBLE_COORDINATOR", "dispatch_namespace", "foreign-dispatch"],
])(
  "refuses inconsistent %s.%s before any writes",
  async (name, field, value) => {
    const settings = updateSettings();
    settings.bindings.find((binding) => binding.name === name)![
      field as string
    ] = value;
    const h = updateHarness(settings);
    await expect(h.client.update(installed, "code", () => {})).rejects.toThrow(
      "backend_update_conflict",
    );
    expect(h.calls.map((call) => call.method)).toEqual(["GET"]);
  },
);

it.each(["STATUS_AUTH_KEY", "ASCROBBLE_STATE", "SCROBBLE_COORDINATOR"])(
  "refuses a missing %s binding",
  async (name) => {
    const settings = updateSettings();
    settings.bindings = settings.bindings.filter(
      (binding) => binding.name !== name,
    );
    const h = updateHarness(settings);
    await expect(h.client.update(installed, "code", () => {})).rejects.toThrow(
      "backend_update_conflict",
    );
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  },
);

it.each([
  ["missing bindings", { bindings: undefined }],
  ["invalid bindings", { bindings: {} }],
  ["missing compatibility date", { compatibility_date: undefined }],
  ["invalid compatibility date", { compatibility_date: "not-a-date" }],
  ["invalid flags", { compatibility_flags: [null] }],
])(
  "refuses %s instead of silently changing runtime configuration",
  async (_, change) => {
    const h = updateHarness({ ...updateSettings(), ...change });
    await expect(h.client.update(installed, "code", () => {})).rejects.toThrow(
      "backend_update_invalid",
    );
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  },
);

it("refuses duplicate or malformed binding names before upload", async () => {
  for (const badBinding of [
    null,
    { name: "unsafe/name", type: "secret_text" },
    { name: "ASCROBBLE_STATE", type: "secret_text" },
    { name: "BAD_TYPE" },
  ]) {
    const settings = updateSettings();
    settings.bindings.push(badBinding as any);
    const h = updateHarness(settings);
    await expect(h.client.update(installed, "code", () => {})).rejects.toThrow(
      "backend_update_invalid",
    );
    expect(h.calls.every((call) => call.method === "GET")).toBe(true);
  }
});

it("keeps bounded numeric diagnostics when a code update is rejected by Cloudflare", async () => {
  const h = updateHarness(
    updateSettings(),
    Response.json(
      {
        success: false,
        errors: [{ code: 10057, message: "synthetic-secret-never-retain" }],
      },
      { status: 400 },
    ),
  );
  let caught: unknown;
  try {
    await h.client.update(installed, "code", () => {});
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CloudflareError);
  expect(caught).toMatchObject({
    code: "update_http",
    status: 400,
    errorCodes: [10057],
  });
  expect(JSON.stringify(caught)).not.toContain("synthetic-secret-never-retain");
  expect(h.calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
});

it("invokes injected browser fetch without binding the Cloudflare client as receiver", async () => {
  const request = function (this: unknown, url: string | URL | Request) {
    if (this !== undefined && this !== globalThis)
      throw new TypeError("Illegal invocation");
    return Promise.resolve(
      Response.json({
        success: true,
        result: String(url).endsWith("/user/tokens/verify")
          ? { status: "active" }
          : [{ id: "a".repeat(32), name: "Fixture" }],
      }),
    );
  } as typeof fetch;
  const client = new Cloudflare("test-token-".repeat(4), request);
  expect(await client.accounts()).toHaveLength(1);
});

const diagnosticSecret = "synthetic-secret-never-retain";
const diagnosticToken = diagnosticSecret + "-token";
const diagnosticUpstream = {
  message: diagnosticSecret,
  token: diagnosticToken,
  url: "https://api.cloudflare.com/client/v4/" + diagnosticSecret,
  body: { secret: diagnosticSecret },
};

function diagnosticClient(response: Response) {
  return new Cloudflare(diagnosticToken, async (url) =>
    String(url).endsWith("/user/tokens/verify")
      ? Response.json({ success: true, result: { status: "active" } })
      : response,
  );
}

async function diagnosticFailure(action: () => unknown | Promise<unknown>) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CloudflareError);
  const error = caught as CloudflareError;
  expect(error.message).toBe(error.code);
  expect(JSON.stringify(error)).not.toContain(diagnosticSecret);
  expect(error.message).not.toContain(diagnosticSecret);
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(
    expect.arrayContaining(["code", "errorCodes", "message", "name"]),
  );
  for (const field of ["body", "url", "token", "response", "cause"])
    expect(Object.hasOwn(error, field)).toBe(false);
  return error;
}

it("distinguishes local token format, account HTTP failure and an empty account list", async () => {
  const malformed = await diagnosticFailure(
    () => new Cloudflare(diagnosticToken + " invalid"),
  );
  const rejected = await diagnosticFailure(() =>
    diagnosticClient(
      Response.json(
        { success: false, errors: [{ code: 9109, ...diagnosticUpstream }] },
        { status: 403 },
      ),
    ).accounts(),
  );
  const empty = await diagnosticFailure(() =>
    diagnosticClient(Response.json({ success: true, result: [] })).accounts(),
  );
  expect([malformed.code, rejected.code, empty.code]).toEqual([
    "token_format",
    "accounts_http",
    "accounts_empty",
  ]);
  expect(malformed.status).toBeUndefined();
  expect(rejected.status).toBe(403);
  expect(rejected.errorCodes).toEqual([9109]);
});

it("retains only bounded, unique numeric Cloudflare codes from platform failures", async () => {
  const codes = [
    9109,
    "9109",
    9109,
    -1,
    1.5,
    null,
    100000000,
    0,
    99999999,
    1001,
    1002,
    1003,
  ];
  const error = await diagnosticFailure(() =>
    diagnosticClient(
      Response.json({
        success: false,
        ...diagnosticUpstream,
        errors: codes.map((code) => ({ code, ...diagnosticUpstream })),
      }),
    ).accounts(),
  );
  expect(error.code).toBe("accounts_platform");
  expect(error.status).toBe(200);
  expect(error.errorCodes).toEqual([9109, 0, 99999999, 1001, 1002]);
  expect(JSON.stringify(error)).not.toContain("api.cloudflare.com");
});

it.each([
  ["non-JSON", () => new Response(diagnosticSecret)],
  ["missing success", () => Response.json(diagnosticUpstream)],
  ["missing result", () => Response.json({ success: true })],
  ["non-array result", () => Response.json({ success: true, result: {} })],
  ["null account", () => Response.json({ success: true, result: [null] })],
  [
    "invalid account ID",
    () => Response.json({ success: true, result: [{ id: diagnosticSecret }] }),
  ],
])(
  "classifies %s account responses without retaining upstream data",
  async (_, response) => {
    const error = await diagnosticFailure(() =>
      diagnosticClient(response()).accounts(),
    );
    expect(error.code).toBe("accounts_invalid");
  },
);

it.each([50, 51])(
  "refuses a truncated account list containing %i accounts",
  async (count) => {
    const error = await diagnosticFailure(() =>
      diagnosticClient(
        Response.json({
          success: true,
          result: Array.from({ length: count }, (_, index) => ({
            id: index.toString(16).padStart(32, "0"),
            name: "Fixture " + index,
          })),
        }),
      ).accounts(),
    );
    expect(error.code).toBe("accounts_limit");
  },
);

it.each([
  [
    "install_http",
    () =>
      Response.json(
        { success: false, errors: [{ code: 10000, ...diagnosticUpstream }] },
        { status: 403 },
      ),
    403,
    [10000],
  ],
  [
    "install_platform",
    () =>
      Response.json({
        success: false,
        errors: [{ code: 10000, ...diagnosticUpstream }],
      }),
    200,
    [10000],
  ],
  ["install_invalid", () => new Response(diagnosticSecret), 200, []],
  ["install_invalid", () => Response.json(diagnosticUpstream), 200, []],
])(
  "uses %s diagnostics for an installation API failure",
  async (code, response, status, codes) => {
    const error = await diagnosticFailure(() =>
      diagnosticClient(response()).call(
        "/accounts/" + initial.account + "/workers/scripts/" + diagnosticSecret,
        "PUT",
        { secret: diagnosticSecret },
      ),
    );
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.errorCodes).toEqual(codes);
  },
);

it("discards non-integer, non-numeric and out-of-range HTTP status metadata", () => {
  for (const status of [
    undefined,
    null,
    "403",
    99,
    600,
    -1,
    403.5,
    NaN,
    Infinity,
  ]) {
    const error = new CloudflareError("accounts_http", status, [9109]);
    expect(error.status).toBeUndefined();
    expect(error.errorCodes).toEqual([9109]);
  }
});

it("retains valid HTTP status metadata at the boundaries", () => {
  for (const status of [100, 403, 599])
    expect(new CloudflareError("accounts_http", status).status).toBe(status);
});

it("ignores non-array error codes and filters non-JSON numeric edge cases", () => {
  expect(
    new CloudflareError("accounts_platform", 200, diagnosticUpstream)
      .errorCodes,
  ).toEqual([]);
  expect(
    new CloudflareError("accounts_platform", 200, [
      NaN,
      Infinity,
      -Infinity,
      42,
      42,
      "43",
      diagnosticUpstream,
    ]).errorCodes,
  ).toEqual([42]);
});

it("verifies an active Token before listing accounts using only read requests", async () => {
  const paths: string[] = [];
  const client = new Cloudflare(diagnosticToken, async (url, init) => {
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    const path = new URL(String(url)).pathname;
    paths.push(path);
    return Response.json({
      success: true,
      result: path.endsWith("/user/tokens/verify")
        ? { status: "active" }
        : [{ id: initial.account, name: "Fixture" }],
    });
  });
  expect(await client.accounts()).toHaveLength(1);
  expect(paths).toEqual([
    "/client/v4/user/tokens/verify",
    "/client/v4/accounts",
  ]);
});

it.each([
  ["expired", "token_expired"],
  ["disabled", "token_disabled"],
  [diagnosticSecret, "token_invalid"],
])(
  "stops before account enumeration for %s Token status",
  async (status, code) => {
    const paths: string[] = [];
    const client = new Cloudflare(diagnosticToken, async (url) => {
      paths.push(new URL(String(url)).pathname);
      return Response.json({
        success: true,
        result: { status, ...diagnosticUpstream },
      });
    });
    const error = await diagnosticFailure(() => client.accounts());
    expect(error.code).toBe(code);
    expect(paths).toEqual(["/client/v4/user/tokens/verify"]);
  },
);

it.each([
  [
    "token_http",
    () =>
      Response.json(
        { success: false, errors: [{ code: 10000, ...diagnosticUpstream }] },
        { status: 403 },
      ),
    403,
    [10000],
  ],
  [
    "token_platform",
    () =>
      Response.json({
        success: false,
        errors: [{ code: 9109, ...diagnosticUpstream }],
      }),
    200,
    [9109],
  ],
  ["token_invalid", () => new Response(diagnosticSecret), 200, []],
  [
    "token_invalid",
    () => Response.json({ success: true, result: {} }),
    undefined,
    [],
  ],
])(
  "classifies %s Token verification without retaining provider text",
  async (code, response, status, codes) => {
    const paths: string[] = [];
    const client = new Cloudflare(diagnosticToken, async (url) => {
      paths.push(new URL(String(url)).pathname);
      return response();
    });
    const error = await diagnosticFailure(() => client.accounts());
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.errorCodes).toEqual(codes);
    expect(paths).toEqual(["/client/v4/user/tokens/verify"]);
  },
);
