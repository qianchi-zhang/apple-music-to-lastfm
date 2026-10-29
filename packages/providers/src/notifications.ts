// General matching behavior preserved from aScrobble 0.3.49.
import type { ProviderContext } from "./runtime";
export function createNotifications(ctx: ProviderContext) {
  const { fetch, Date, console, setTimeout } = ctx;

  // src/notify.ts
  async function notifyTokenExpired(webhookUrl?: any): Promise<any> {
    if (!webhookUrl) return;
    await postMessage(
      webhookUrl,
      "\u{1F534} **aScrobble**: Apple Music tokens expired (401).\nRe-open the aScrobble desktop app to re-authenticate with Apple Music.",
    );
  }
  async function notifyMilestone(webhookUrl?: any, total?: any): Promise<any> {
    if (!webhookUrl) return;
    await postMessage(
      webhookUrl,
      `\u{1F3B5} **aScrobble**: hit **${total.toLocaleString()}** total scrobbles`,
    );
  }
  async function notifySummary(
    webhookUrl?: any,
    accepted?: any,
    repeatCount?: any,
    ignored?: any,
  ): Promise<any> {
    if (!webhookUrl || accepted === 0) return;
    const parts: any = [`**${accepted}** scrobbled`];
    if (repeatCount > 0) parts.push(`${repeatCount} repeat plays`);
    if (ignored > 0) parts.push(`${ignored} ignored`);
    await postMessage(webhookUrl, "\u{1F3B5} " + parts.join(" \xB7 "));
  }
  async function postMessage(webhookUrl?: any, message?: any): Promise<any> {
    try {
      const r: any = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Discord uses "content", Slack accepts "text"; sending both covers both.
        body: JSON.stringify({ content: message, text: message }),
      });
      if (!r.ok) {
        const body: any = await r.text();
        console.warn(`Notify webhook ${r.status}: ${body.slice(0, 200)}`);
      }
    } catch (e: any) {
      console.warn("Notify webhook error:", e);
    }
  }
  return { notifyTokenExpired, notifyMilestone, notifySummary, postMessage };
}
