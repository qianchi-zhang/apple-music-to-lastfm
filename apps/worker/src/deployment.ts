export interface DeploymentMetadata {
  DEPLOYMENT_WORKER_NAME?: string;
  DEPLOYMENT_ACCOUNT_ID?: string;
}
/** Only deployment-owned metadata is used to construct the management link. */
export function deploymentInfo(env: DeploymentMetadata) {
  const worker = /^[a-z0-9][a-z0-9-]{0,62}$/.test(
    env.DEPLOYMENT_WORKER_NAME ?? "",
  )
    ? env.DEPLOYMENT_WORKER_NAME!
    : null;
  const account = /^[a-f0-9]{32}$/i.test(env.DEPLOYMENT_ACCOUNT_ID ?? "")
    ? env.DEPLOYMENT_ACCOUNT_ID!
    : null;
  return {
    provider: "Cloudflare",
    worker_name: worker,
    dashboard_url:
      account && worker
        ? `https://dash.cloudflare.com/${account}/workers/services/view/${worker}/production`
        : "https://dash.cloudflare.com/",
    account_management_authorized: false,
  };
}
