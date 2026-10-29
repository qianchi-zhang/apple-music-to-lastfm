/** Prepare a reviewable source template; never publish or copy local credentials. */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
const output = "dist/install-template";
const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
}).split("\0");
const files = tracked.filter(
  (file) =>
    /^(apps\/(worker|browser-extension)\/|packages\/)/.test(file) ||
    [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "LICENSE",
      "docs/BASELINE.md",
    ].includes(file),
);
for (const file of files) {
  if (!/\.(ts|json|html|css|md)$/.test(file) && file !== "LICENSE") continue;
  if (/(^|\/)(\.env|\.dev|.*\.local\.)/.test(file))
    throw Error("Local file refused");
  await mkdir(dirname(output + "/" + file), { recursive: true });
  await copyFile(file, output + "/" + file);
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts = { deploy: "wrangler deploy", typecheck: "tsc --noEmit" };
pkg.cloudflare = {
  bindings: {
    STATUS_AUTH_KEY: {
      description:
        "粘贴安装页面生成并保存的管理钥匙，用它打开自己的控制台。不要填写音乐账户密码。",
    },
  },
};
await writeFile(output + "/package.json", JSON.stringify(pkg, null, 2) + "\n");
await writeFile(
  output + "/wrangler.jsonc",
  JSON.stringify(
    {
      name: "apple-music-scrobbler",
      main: "apps/worker/src/index.ts",
      compatibility_date: "2026-09-08",
      workers_dev: true,
      kv_namespaces: [{ binding: "ASCROBBLE_STATE", id: "auto-provisioned" }],
      durable_objects: {
        bindings: [
          { name: "SCROBBLE_COORDINATOR", class_name: "ScrobbleCoordinator" },
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ScrobbleCoordinator"] }],
      triggers: { crons: [] },
      observability: { enabled: false },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  output + "/.gitignore",
  "node_modules/\n.wrangler/\n.dev.vars*\n.env*\ndist/\n",
);
await writeFile(
  output + "/README.md",
  `# Apple Music Scrobbler 安装模板\n\n此目录用于 Cloudflare 官方网页部署。个人服务默认暂停，完成 Apple Music 和 Last.fm 连接后在 /setup 开启记录。STATUS_AUTH_KEY 使用安装页面生成并自行保存的管理钥匙。\n\n本项目基于 aScrobble 修复代码重构，采用随附 GPL-3.0 许可证；来源和基线说明见 docs/BASELINE.md。安装模板不含维护者的账户或音乐凭据。\n\n模板尚需在 Cloudflare 官方安装流程实测；生成本目录不会公开代码或部署服务。\n`,
);
console.log(
  "Prepared " + output + " for review. Nothing published or deployed.",
);
