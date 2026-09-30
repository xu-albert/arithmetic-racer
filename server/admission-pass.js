// Signed, short-lived admission passes keep a room name from being a room
// credential. The Worker issues a pass after matchmaking or room allocation;
// the room verifies it at hello.

export const ADMISSION_PASS_TTL_MS = 10 * 60 * 1000;

function secretFor(env) {
  const secret = env?.ADMISSION_PASS_SECRET ?? env?.BETTER_AUTH_SECRET;
  return typeof secret === "string" && secret.length >= 16 ? secret : null;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const text = (value) => new TextEncoder().encode(value);

async function keyFor(secret) {
  return crypto.subtle.importKey("raw", text(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueAdmissionPass(env, roomId, mode, now = Date.now()) {
  const secret = secretFor(env);
  if (!secret) throw new Error("admission pass secret is not configured");
  const payload = base64Url(text(JSON.stringify({ roomId, mode, exp: now + ADMISSION_PASS_TTL_MS })));
  const signature = await crypto.subtle.sign("HMAC", await keyFor(secret), text(payload));
  return `v1.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyAdmissionPass(env, pass, { roomId, mode, now = Date.now() }) {
  const secret = secretFor(env);
  if (!secret || typeof pass !== "string") return false;
  const parts = pass.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  let payload;
  let signature;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    signature = decodeBase64Url(parts[2]);
  } catch {
    return false;
  }
  if (!payload || payload.roomId !== roomId || payload.mode !== mode
    || !Number.isFinite(payload.exp) || payload.exp <= now) return false;
  try {
    return await crypto.subtle.verify("HMAC", await keyFor(secret), signature, text(parts[1]));
  } catch {
    return false;
  }
}
