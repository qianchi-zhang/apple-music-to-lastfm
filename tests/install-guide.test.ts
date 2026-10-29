import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// Execute the shipped static script against its DOM boundary.
function guide(value: string, clipboardAllowed = true) {
  const listeners: Record<
    string,
    (event: { preventDefault(): void }) => unknown
  > = {};
  const elements = Object.fromEntries(
    [
      "copy-extensions-url",
      "copy-status",
      "console-form",
      "console-url",
      "url-status",
    ].map((id) => [
      id,
      {
        value,
        textContent: "",
        addEventListener: (_: string, handler: (typeof listeners)[string]) => {
          listeners[id] = handler;
        },
      },
    ]),
  );
  const opened: unknown[][] = [];
  const copied: string[] = [];
  runInNewContext(readFileSync("apps/install-site/guide.js", "utf8"), {
    document: { getElementById: (id: string) => elements[id] },
    navigator: {
      clipboard: {
        writeText: async (text: string) => {
          if (!clipboardAllowed) throw Error("denied");
          copied.push(text);
        },
      },
    },
    window: { open: (...args: unknown[]) => opened.push(args) },
    URL,
  });
  return { listeners, elements, opened, copied };
}
it("opens only a personal HTTPS Workers console without forwarding credentials", () => {
  for (const suffix of ["", "/setup"]) {
    const valid = guide("https://my-service.my-account.workers.dev" + suffix);
    valid.listeners["console-form"]({ preventDefault() {} });
    expect(valid.opened).toEqual([
      [
        "https://my-service.my-account.workers.dev/setup",
        "_blank",
        "noopener,noreferrer",
      ],
    ]);
  }
  for (const input of [
    "javascript:alert(1)",
    "https://evil.test",
    "https://a.b.workers.dev.evil.test",
    "https://secret@a.b.workers.dev",
    "https://a.b.workers.dev/?token=secret",
    "https://a.b.workers.dev/api/v1/connections/lastfm/callback",
    "http://a.b.workers.dev",
    "https://a.b.workers.dev/#secret",
    "https://a.b.workers.dev:8443",
    "https://a.b.workers.dev/setup/other",
  ]) {
    const invalid = guide(input);
    invalid.listeners["console-form"]({ preventDefault() {} });
    expect(invalid.opened).toEqual([]);
    expect(invalid.elements["url-status"].textContent).toContain("请勿粘贴");
  }
});
it("copies only the Chrome settings address with an actionable manual fallback", async () => {
  const page = guide("");
  await page.listeners["copy-extensions-url"]({ preventDefault() {} });
  expect(page.copied).toEqual(["chrome://extensions"]);
  expect(page.elements["copy-status"].textContent).toContain("Chrome 地址栏");
  const denied = guide("", false);
  await denied.listeners["copy-extensions-url"]({ preventDefault() {} });
  expect(denied.elements["copy-status"].textContent).toContain(
    "手动输入 chrome://extensions",
  );
});
it("routes all guide links and old setup bookmarks to usable static instructions", () => {
  const html = readFileSync("apps/install-site/index.html", "utf8");
  const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const links = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  for (const link of links) expect(ids).toContain(link);
  expect(html).toContain("下载完整扩展");
  expect(html).not.toContain("暂时不能完成");
  expect(html).not.toContain("generate-key");
  const panels = Object.fromEntries(ids.map((id) => [id, { hidden: false }]));
  const current = new Set<string>();
  const location = { hash: "#deploy" };
  let onHashChange = () => {};
  runInNewContext(readFileSync("apps/install-site/wizard.js", "utf8"), {
    document: {
      getElementById: (id: string) => panels[id],
      querySelector: (selector: string) => ({
        setAttribute: () => current.add(selector),
        removeAttribute: () => current.delete(selector),
      }),
    },
    location,
    window: {
      addEventListener: (_: string, handler: () => void) => {
        onHashChange = handler;
      },
    },
  });
  expect(panels.connect.hidden).toBe(false);
  expect(panels.prepare.hidden).toBe(true);
  expect([...current]).toEqual(['nav a[href="#connect"]']);
  location.hash = "#constructor";
  onHashChange();
  expect(panels.prepare.hidden).toBe(false);
  expect(panels.connect.hidden).toBe(true);
});
