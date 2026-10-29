export interface Deployment {
  accountId: string;
  workerName: string;
  namespaceId?: string;
}
const id = /^[a-f0-9]{32}$/;
export function validateDeployment(value: unknown): Deployment {
  const state = value as Partial<Deployment> | null;
  if (
    !state ||
    typeof state !== "object" ||
    typeof state.accountId !== "string" ||
    !id.test(state.accountId) ||
    typeof state.workerName !== "string" ||
    !/^apple-music-scrobbler-[a-f0-9]{12}$/.test(state.workerName) ||
    (state.namespaceId !== undefined &&
      (typeof state.namespaceId !== "string" || !id.test(state.namespaceId)))
  )
    throw Error(
      "部署状态文件无效，未修改任何远端资源。请检查 deployment.local.json。",
    );
  return {
    accountId: state.accountId,
    workerName: state.workerName,
    ...(state.namespaceId ? { namespaceId: state.namespaceId } : {}),
  };
}
export function selectNamespace(
  value: unknown,
  title: string,
): { id: string } | undefined {
  if (!Array.isArray(value))
    throw Error("无法读取 Cloudflare KV 列表，请稍后重试。");
  const matches = value.filter((entry) => entry?.title === title);
  if (matches.length > 1)
    throw Error("发现多个同名 KV，无法安全选择。请在 Cloudflare 检查资源。");
  if (!matches.length) return undefined;
  if (typeof matches[0].id !== "string" || !id.test(matches[0].id))
    throw Error("Cloudflare 返回无效的 KV 标识，未继续部署。");
  return { id: matches[0].id };
}
export function deploymentConfig(state: Deployment) {
  return {
    name: state.workerName,
    account_id: state.accountId,
    main: "dist/worker.js",
    no_bundle: true,
    compatibility_date: "2026-09-08",
    workers_dev: true,
    vars: {
      DEPLOYMENT_WORKER_NAME: state.workerName,
      DEPLOYMENT_ACCOUNT_ID: state.accountId,
    },
    kv_namespaces: state.namespaceId
      ? [{ binding: "ASCROBBLE_STATE", id: state.namespaceId }]
      : [],
    durable_objects: {
      bindings: [
        { name: "SCROBBLE_COORDINATOR", class_name: "ScrobbleCoordinator" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ScrobbleCoordinator"] }],
    triggers: { crons: [] },
    observability: { enabled: false },
  };
}
