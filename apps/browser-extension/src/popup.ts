import { captureAppleCredentials, inspectAppleConnection } from "./capture";
import { backendOrigin, isAppleTab, connectApple, errors } from "./connection";
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const backend = input("backend"),
  key = input("key");
const button = document.getElementById("connect") as HTMLButtonElement;
const check = document.getElementById("check") as HTMLButtonElement;
const status = document.getElementById("status")!;
const diagnostic = document.getElementById("diagnostic")!;
const destination = document.getElementById("destination")!;
function show(text: string, kind = "info") {
  status.textContent = text;
  status.dataset.kind = kind;
}
function updateDestination() {
  try {
    destination.textContent = "凭据仅发送到：" + backendOrigin(backend.value);
  } catch {
    destination.textContent = "填写后会在这里显示接收凭据的网站。";
  }
}
backend.addEventListener("input", updateDestination);
void chrome.storage.local
  .get("backend")
  .then((saved) => {
    if (typeof saved.backend === "string") {
      backend.value = saved.backend;
      updateDestination();
    }
  })
  .catch(() => {});
document
  .getElementById("open")!
  .addEventListener(
    "click",
    () => void chrome.tabs.create({ url: "https://music.apple.com/" }),
  );
button.addEventListener("click", async () => {
  diagnostic.textContent = "";
  let origin: string;
  try {
    origin = backendOrigin(backend.value);
  } catch {
    show(errors.invalid_backend, "error");
    return;
  }
  if (!key.value.trim()) {
    show(errors.invalid_key, "error");
    return;
  }
  button.disabled = true;
  check.disabled = true;
  backend.disabled = true;
  key.disabled = true;
  try {
    // Request the exact destination during the user gesture, before reading any token.
    const permission = await chrome.permissions.request({
      origins: [origin + "/*"],
    });
    if (!permission) throw Error("permission_denied");
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !isAppleTab(tab.url)) throw Error("wrong_tab");
    show("正在读取你已登录的 Apple Music 连接…");
    const result = await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: captureAppleCredentials,
      })
      .catch(() => {
        throw Error("capture_failed");
      });
    const value = result[0]?.result;
    if (!value) throw Error("tokens_unavailable");
    if ("error" in value) throw Error(value.error);
    show("正在由你的后台验证 Apple Music 读取权限…");
    try {
      await connectApple(origin, key.value, value.credentials);
    } finally {
      value.credentials.apple_dev_token = "";
      value.credentials.apple_user_token = "";
    }
    key.value = "";
    await chrome.storage.local.set({ backend: origin }).catch(() => {});
    show(
      "Apple Music 已连接并验证。现在可以关闭此窗口，回到网页继续设置 Last.fm。",
      "success",
    );
    button.textContent = "重新连接";
  } catch (error) {
    const code =
      error instanceof Error && errors[error.message]
        ? error.message
        : "backend_error";
    show(errors[code], "error");
    diagnostic.textContent = "诊断代码：" + code + " · 连接助手 0.1.0";
  } finally {
    button.disabled = false;
    check.disabled = false;
    backend.disabled = false;
    key.disabled = false;
  }
});

check.addEventListener("click", async () => {
  check.disabled = true;
  button.disabled = true;
  diagnostic.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !isAppleTab(tab.url)) throw Error("wrong_tab");
    const result = await chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: inspectAppleConnection,
      })
      .catch(() => {
        throw Error("capture_failed");
      });
    const value = result[0]?.result;
    if (!value) throw Error("tokens_unavailable");
    if (value.error) throw Error(value.error);
    show(
      "已检测到 Apple Music 登录凭据。没有发送或保存任何凭据；API 访问能力尚未验证。",
      "success",
    );
  } catch (error) {
    const code =
      error instanceof Error && errors[error.message]
        ? error.message
        : "capture_failed";
    show(errors[code], "error");
    diagnostic.textContent = "诊断代码：" + code + " · 连接助手 0.1.0";
  } finally {
    check.disabled = false;
    button.disabled = false;
  }
});
