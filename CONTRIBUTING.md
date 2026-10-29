# 贡献与维护

使用 Node.js 22+，运行 `npm ci`。当前扩展入口为 `apps/browser-extension/emil.html` 和 `src/emil-app.ts`；当前 Worker 入口为 `apps/worker/src/production-entry.ts`。`packages` 中保留的历史模块与其他 UI 入口仍有回归依赖，不代表当前默认运行路径。

修改源码后执行：

```sh
npm run typecheck
npm test
npm run test:production
npm run package:extension
```

不要手改 `dist`、生成的运行时或冻结算法原文。算法升级需要核对版本、摘要、回归样本、扩展内算法附件及 Worker 上传载荷；不要只改版本号。随附许可证与版权声明需要随发布保留。

CI 只测试和打包，不部署、不迁移生产数据。测试使用明确的模拟服务响应，生产算法回归禁止真实网络。不要用虚假播放写入真实 Last.fm 账户。

本地 `.dev.vars*`、`.env*`、`*.local.json`、`.wrangler`、`node_modules`、构建产物与报告不提交；示例只用占位符。新增 fixture 使用公开元数据与合成账户标识。报告问题请提供步骤、版本、固定错误提示和脱敏截图，不要提交 Token、Shared Secret、管理钥匙、会话密钥、请求标头或授权回调参数。

仓库从当前可交付版本开始记录历史。日常变更使用短分支与 Pull Request，说明行为改变及验证结果。公开发布需要关联通过 CI 的提交和标签，并提供匹配的源码与安装包。
