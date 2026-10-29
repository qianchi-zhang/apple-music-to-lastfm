# 第一次使用 Cloudflare：获取 Token 并安装后台

Cloudflare 用来运行你的个人后台。API Token（访问令牌）允许余音在你选定的 Cloudflare 账户里完成本次安装。以下步骤也已放进控制台的「连接 → 个人后台」引导中；已有 Token 可点击「我已经有 Token」直接填写。

## 1. 准备账户和后台网址

登录 Cloudflare；没有账户先注册并完成邮箱验证。打开 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，选择本次安装要使用的账户。首次使用时按官网提示完成 Workers 初始化。

在 **Your subdomain（你的子域名）**处确认已有 `xxx.workers.dev`。余音会使用这个网址，不需要购买或接入自己的域名。

## 2. 创建自定义 Token

打开 [API Tokens 页面](https://dash.cloudflare.com/profile/api-tokens)。手动进入时，路径是右上角头像 → **My Profile（我的个人资料）** → **API Tokens**。

点击 **Create Token（创建令牌）**，找到 **Create Custom Token（自定义令牌）**并点击 **Get started（开始使用）**。名称可以填「余音部署」。

## 3. 添加三项权限

在 **Permissions（权限）**中，每行的三个下拉框依次选下表内容。用 **Add more（添加更多）**增加下一行。

| 类别    | 权限               | 级别         |
| ------- | ------------------ | ------------ |
| Account | Account Settings   | Read（读取） |
| Account | Workers Scripts    | Edit（编辑） |
| Account | Workers KV Storage | Edit（编辑） |

三行的第一项都选 **Account（账户）**。这次安装不需要 Zone（区域）、DNS 或其他权限。

## 4. 限定账户范围

在 **Account Resources（账户资源）**中选 **Include（包括）**，再指定第 1 步选择的那个账户。如果有多个账户，只选择本次安装要使用的一个。

其余可选项可保留默认。如果设置 Token 有效期，需确保它在本次安装期间有效。

## 5. 生成并复制

点击 **Continue to summary（继续到摘要）**，核对三项权限及账户，然后点击 **Create Token**。

在结果页点击 **Copy（复制）**。完整 Token 只显示一次，请复制整串内容。余音需要 Token 本身，不是 Token 名称、Account ID 或 Global API Key。

## 6. 回余音验证并安装

将 Token 粘贴到控制台的 **Cloudflare API Token** 输入框，点击 **验证 Token**。验证成功后教程会收起，并显示可用的部署账户。

选择与第 1 步相同的账户，点击 **安装个人后台**，保持页面打开。成功后会进入 Apple Music 连接步骤；新后台默认暂停，不会立刻开始记录。

Token 仅在本页内存中用于本次安装，不会保存。安装成功后可回 Cloudflare 撤销这个 Token。需要继续中断的安装时，可以重新创建同账户的 Token，并保留原来的安装信息。

## 官方参考

本次于 2026-10-25 核对 [创建 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)、[API Token 权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)及 [workers.dev 网址说明](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)。本指南使用用户 Token 的入口和自定义权限，不使用预设所有账户范围的模板链接。
