/** Cross-platform bootstrap. Wrangler owns Cloudflare login; no OAuth credentials are read here. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir, rmdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  deploymentConfig,
  selectNamespace,
  validateDeployment,
} from "./setup-model";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
const configPath = resolve(root, "wrangler.personal.local.json");
const secretPath = resolve(root, ".dev.vars.personal");
const statePath = resolve(root, "deployment.local.json");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const dryRun = process.argv.includes("--dry-run");
if (process.argv.slice(2).some((arg) => arg !== "--dry-run"))
  throw Error("仅支持 --dry-run。运行 npm run setup 进入引导。");

function command(
  args: string[],
  capture = false,
  input?: string,
): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd: root,
      shell: false,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: [
        input === undefined ? "inherit" : "pipe",
        capture ? "pipe" : "inherit",
        "inherit",
      ],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () =>
      fail(Error("无法启动 Wrangler，请先执行 npm ci。")),
    );
    child.on("close", (code) =>
      code === 0
        ? done(output)
        : fail(
            Error(
              "Cloudflare 操作未完成。请根据上方提示处理后重新运行 npm run setup；已保存的部署信息会被复用。",
            ),
          ),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}
async function readOptional(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function saveJson(path: string, data: unknown) {
  const temp = path + ".tmp";
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
async function main() {
  if (dryRun) {
    console.log(
      "预览：登录你自己的 Cloudflare → 选择账户 → 创建独立 KV 和 Worker → 保存管理密钥 → 验证网页。\n不会读取登录凭据、调用 Cloudflare 或写入文件。自动记录默认关闭。",
    );
    console.log(
      JSON.stringify(
        deploymentConfig({
          accountId: "0".repeat(32),
          workerName: "apple-music-scrobbler-example",
          namespaceId: "1".repeat(32),
        }),
        null,
        2,
      ),
    );
    return;
  }
  if (!process.stdin.isTTY)
    throw Error("请在交互式终端运行 npm run setup，或用 --dry-run 预览。");
  try {
    await mkdir(".setup-lock");
  } catch {
    throw Error(
      "部署锁已存在。请先关闭其他部署进程；若上次被强制退出，确认没有部署正在运行后删除 .setup-lock 目录再重试。",
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(
      "Apple Music Scrobbler · 独立部署\n服务和播放记录放在你选择的 Cloudflare 账户。自动记录默认关闭。\n",
    );
    const savedText = await readOptional(statePath);
    let state = savedText
      ? validateDeployment(JSON.parse(savedText))
      : undefined;
    console.log("[1/5] 检查 Cloudflare 登录与部署账户…");
    let identity: { accounts: { id: string; name: string }[] };
    try {
      identity = JSON.parse(await command(["whoami", "--json"], true));
    } catch {
      console.log(
        "请在即将打开的 Cloudflare 官方页面登录并授权 Wrangler，然后回到这里。",
      );
      await command(["login"]);
      identity = JSON.parse(await command(["whoami", "--json"], true));
    }
    if (!Array.isArray(identity.accounts) || !identity.accounts.length)
      throw Error(
        "没有可部署的账户。请在 Cloudflare 创建账户，或请账户管理员提供 Workers 权限。",
      );
    if (!state) {
      identity.accounts.forEach((account, index) =>
        console.log(`${index + 1}. ${account.name} (${account.id})`),
      );
      const answer = await prompt.question("选择部署账户编号：");
      if (!/^[1-9]\d*$/.test(answer))
        throw Error("请输入列表中的账户编号，然后重试。");
      const account = identity.accounts[Number(answer) - 1];
      if (!account) throw Error("账户编号不存在，请重新运行。");
      state = validateDeployment({
        accountId: account.id,
        workerName:
          "apple-music-scrobbler-" +
          Buffer.from(randomBytes(6)).toString("hex"),
      });
      await saveJson(statePath, state);
    }
    const account = identity.accounts.find(
      (account) => account.id === state.accountId,
    );
    if (!account)
      throw Error(
        "当前登录账号无法访问已保存的部署账户。请先运行 npx wrangler logout 和 npx wrangler login 切换账号。",
      );
    console.log(
      `\n部署账户：${account.name} (${account.id})\n独立服务：${state.workerName}\n`,
    );
    if (
      (
        await prompt.question("按 Enter 开始或继续部署，输入 q 退出：")
      ).trim() !== ""
    )
      return;
    console.log("[2/5] 保存本地部署信息与管理密钥…");
    // Save the key before any remote mutation. On retry, never rotate it silently.
    let secret = await readOptional(secretPath);
    if (!secret && state.namespaceId)
      throw Error(
        "已存在部署，但本地管理密钥丢失。请恢复 .dev.vars.personal 备份；程序不会自动重置密钥。",
      );
    if (!secret) {
      secret = `STATUS_AUTH_KEY=${Buffer.from(randomBytes(32)).toString("hex")}\n`;
      await writeFile(secretPath, secret, { mode: 0o600, flag: "wx" });
    }
    if (!/^STATUS_AUTH_KEY=[a-f0-9]{64}\n?$/.test(secret))
      throw Error(
        "本地管理密钥文件格式不正确。请检查 .dev.vars.personal；程序不会覆盖它。",
      );
    await saveJson(configPath, deploymentConfig(state));
    console.log("[3/5] 检查或创建独立存储…");
    if (!state.namespaceId) {
      const title = state.workerName + "-state";
      const list = async () =>
        JSON.parse(
          await command(
            ["kv", "namespace", "list", "--config", configPath],
            true,
          ),
        );
      let namespace = selectNamespace(await list(), title);
      if (!namespace) {
        await command([
          "kv",
          "namespace",
          "create",
          title,
          "--config",
          configPath,
          "--update-config",
          "false",
        ]);
        namespace = selectNamespace(await list(), title);
      }
      if (!namespace)
        throw Error(
          "暂时无法确认 KV 创建结果。请重新运行；程序会先查找同名资源，避免重复创建。",
        );
      state.namespaceId = namespace.id;
      await saveJson(statePath, state);
      await saveJson(configPath, deploymentConfig(state));
    }
    console.log("[4/5] 配置并发布独立后台…");
    // Secret bulk creates a new Worker if absent. No platform tokens are bundled.
    await command(
      ["secret", "bulk", "--config", configPath],
      false,
      JSON.stringify({ STATUS_AUTH_KEY: secret.split("=")[1].trim() }),
    );
    console.log("正在发布 Worker，请等待部署结果…");
    const deploymentOutput = await command(
      ["deploy", "--config", configPath],
      true,
    );
    console.log(deploymentOutput);
    console.log("[5/5] 检查网页是否可访问…");
    const urls = [
      ...new Set(
        deploymentOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/g) ?? [],
      ),
    ];
    if (urls.length === 1) {
      try {
        const response = await fetch(urls[0] + "/health", {
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        });
        const health = (await response.json()) as {
          ok?: boolean;
          service?: string;
        };
        if (
          !response.ok ||
          health.ok !== true ||
          health.service !== "apple-music-scrobbler"
        )
          throw Error();
        console.log("网页服务已响应：" + urls[0] + "/setup");
      } catch {
        console.log(
          "部署已发布，但暂时无法确认网址可访问。请稍后打开上方网址；无需重新创建资源。",
        );
      }
    }
    console.log(
      `\n部署命令已完成。请打开 Wrangler 上方显示的网址，并进入 /setup。\n管理密钥保存在 ${secretPath}，打开文件后复制等号右侧内容到网页；不要分享这个文件。\n依次连接 Apple Music、配置自己的 Last.fm API 应用、授权 Last.fm。\n连接助手目录：${resolve(root, "dist/browser-extension")}\n此次部署没有启用自动记录。`,
    );
  } finally {
    prompt.close();
    await rmdir(".setup-lock");
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "部署未完成，请重新运行。",
  );
  process.exitCode = 1;
});
