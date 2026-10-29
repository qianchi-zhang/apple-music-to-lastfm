// This static guide never reads or stores service credentials.
document
  .getElementById("copy-extensions-url")
  .addEventListener("click", async () => {
    const status = document.getElementById("copy-status");
    try {
      await navigator.clipboard.writeText("chrome://extensions");
      status.textContent = "已复制，请粘贴到 Chrome 地址栏并按回车。";
    } catch {
      status.textContent =
        "无法自动复制。请在 Chrome 地址栏手动输入 chrome://extensions。";
    }
  });
document.getElementById("console-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const status = document.getElementById("url-status");
  try {
    const url = new URL(document.getElementById("console-url").value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) ||
      !["/", "/setup"].includes(url.pathname) ||
      url.search ||
      url.hash
    )
      throw Error();
    window.open(url.origin + "/setup", "_blank", "noopener,noreferrer");
    status.textContent =
      "已请求打开你的控制台；如果没有出现新标签页，请允许浏览器弹出窗口后重试。";
  } catch {
    status.textContent =
      "请输入部署完成时提供的 https://服务名.子域名.workers.dev 地址，可带 /setup，请勿粘贴授权回调或密钥。";
  }
});
