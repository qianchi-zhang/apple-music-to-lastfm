import { cookie } from "./lastfm-connection";
const name = "__Host-scrobbler-setup";
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, "0")).join(
    "",
  );
async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}
export async function setupCookie(secret: string, now = Date.now()) {
  const payload = String(now + 3600000) + "." + crypto.randomUUID();
  return `${name}=${payload}.${await sign(payload, secret)}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`;
}
export async function validSetupSession(
  request: Request,
  secret: string,
  now = Date.now(),
) {
  const value = cookie(request, name),
    parts = value.split(".");
  if (
    parts.length !== 3 ||
    !/^\d{13}$/.test(parts[0]) ||
    Number(parts[0]) <= now ||
    Number(parts[0]) > now + 3600000 ||
    !/^[a-f0-9-]{36}$/.test(parts[1]) ||
    !/^[a-f0-9]{64}$/.test(parts[2])
  )
    return false;
  const expected = await sign(parts[0] + "." + parts[1], secret);
  let difference = 0;
  for (let i = 0; i < 64; i++)
    difference |= expected.charCodeAt(i) ^ parts[2].charCodeAt(i);
  return difference === 0;
}
