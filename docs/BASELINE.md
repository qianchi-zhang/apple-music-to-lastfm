# 共享模块与构建入口

扩展界面入口为 `apps/browser-extension/emil.html` 与 `apps/browser-extension/src/emil-app.ts`。后台入口为 `apps/worker/src/production-entry.ts`，记录引擎文件为 `apps/worker/production/worker-0.3.111.js`。

`packages/` 中的 TypeScript 模块供共享功能与测试使用。构建前会校验记录引擎摘要，构建后验证扩展附件、Worker 载荷和 ZIP 一致性，参见[记录算法与后台兼容](algorithm-alignment-0.3.111.md)。

生成的 Worker bundle 不直接编辑或提交。
