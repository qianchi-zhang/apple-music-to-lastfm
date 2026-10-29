# Apple Music to Last.fm · 余音

Connect Apple Music to Last.fm and keep a history of the music you listen to.

把 Apple Music 的聆听记录同步到 Last.fm，留住自己听过的歌。通过 Chrome 扩展完成连接，后台运行在自己的 Cloudflare 账户中，无需本地服务。

**版本 0.1.0 · Chrome 103+ · 预览版**

[下载预览版](https://github.com/qianchi-zhang/apple-music-to-lastfm/releases/tag/v0.1.0) · [安装指南](docs/quick-start.md) · [数据与隐私](docs/data-and-privacy.md) · [反馈问题](https://github.com/qianchi-zhang/apple-music-to-lastfm/issues)

## 为什么做这个工具

我们用 Apple Music 听歌，也希望在 Last.fm 留下自己的聆听历史。但 Apple Music 没有内置直接连接 Last.fm 的功能。

于是有了余音：连接两者，把听过的歌曲记录下来。完成设置并开启记录后，就可以继续按平时的习惯听歌，在 Last.fm 回看自己的音乐足迹。

## 安装

1. 从 Release 下载 `browser-extension.zip` 并解压。
2. 打开 `chrome://extensions`，开启开发者模式，点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的 `browser-extension` 目录。
3. 点击扩展图标，依次连接自己的 Cloudflare、Apple Music 和 Last.fm。
4. 设置完成后点击「开始自动记录」，再正常播放新歌。

普通用户无需 npm。本版未上架 Chrome 商店；首次安装需要在官网申请 Cloudflare Token 和自己的 Last.fm API 应用。首次部署默认暂停，授权返回不会自动开启记录。

已安装开发版的用户，请用新包内容覆盖原加载目录，保留原路径，再重新加载原扩展、关闭旧控制台并重新打开。到「设置 → 更新个人后台」更新原实例一次，保留连接与记录；单独更新扩展不会更新云端代码。

## 功能

- 三步连接和同页 Last.fm 授权，中文错误提示与恢复入口。
- 最近十首聆听记录、Apple 原曲目专辑封面、本机七天封面 URL 缓存，以及 Last.fm 主页入口。
- 浅色、深色、跟随系统外观；支持键盘操作和窄屏布局。
- Cloudflare 后台定时读取播放，关闭控制台后仍可运行；可随时暂停或恢复。
- 运行故障显示具体原因；Last.fm 换账户时暂停，保留原账户的待提交歌曲。

页面只展示最近十首，云端另有账本、待处理队列及匹配缓存。[完整数据说明](docs/data-and-privacy.md)。

## 注意事项

**卸载或禁用扩展不会停止云端后台。** 卸载前请先暂停并确认，提前备份管理钥匙。暂停不删除账户凭据、待处理歌曲或 Last.fm 已接受的记录；当前没有丢失本地安装信息后的导入恢复界面。

Apple 最近播放为轮询快照，存在识别延迟，不能保证捕获每次播放或恰好一次提交。本版不提供无限历史归档、导入其他部署或静默自动升级。部分歌曲名称显示规则尚未提供用户配置。

发布前已有用户确认更新后台后新播放成功记录到 Last.fm。自动验证包含 802 项应用测试、31 项算法回归和安装包一致性检查；长时间运行、Windows 和完整暂停恢复仍需更多实机验证。测试样本使用公开元数据与合成账户标识，不携带真实凭据。

## 开发

需要 Node.js 22 或更新版本：

```sh
npm ci
npm run typecheck
npm test
npm run test:production
npm run package:extension
```

构建输出：`dist/site/browser-extension.zip` 和 `dist/browser-extension/`。GitHub Actions 执行同样的检查，上传 ZIP 与产物摘要，不部署个人后台。

`npm run preview:extension` 提供隔离模拟预览；它不读取真实账户，不部署服务，不能替代真实播放验收。

| 目录                                  | 内容                                     |
| ------------------------------------- | ---------------------------------------- |
| `apps/browser-extension`              | 扩展控制台、连接助手及部署流程           |
| `apps/worker/src/production-entry.ts` | 当前后台的授权、启停及调度适配           |
| `apps/worker/production`              | 固定记录算法及随附许可证                 |
| `packages`                            | 部分共享与保留的历史模块，非当前后台入口 |
| `tests`、`scripts`                    | 回归样本、构建、打包及验证               |
| `docs`                                | 安装、数据、算法及素材来源说明           |

## 许可证

[GPL-3.0](LICENSE) · [组件许可说明](THIRD_PARTY_NOTICES.md)

[文档导航](docs/README.md) · [贡献指南](CONTRIBUTING.md) · [版本记录](CHANGELOG.md)
