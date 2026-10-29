/** The extension is the sole management surface for the current Worker build. */
export function extensionHomePage() {
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>个人后台 · 余音</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:420px;padding:40px;text-align:center}h1{margin:0 0 14px;font-size:26px;line-height:1.25;letter-spacing:-.6px;font-weight:600}p{margin:0;color:#6e6e73;font-size:15px;line-height:1.65}@media(prefers-color-scheme:dark){body{background:#161617;color:#f5f5f7}p{color:#a1a1a6}}</style><main><h1>余音的个人后台</h1><p>连接账户、查看聆听记录或暂停记录，请回到 Chrome 中的余音页面。</p></main></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
