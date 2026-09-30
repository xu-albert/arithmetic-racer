// Signed, short-lived admission passes keep a room name from being a room
// credential. The Worker issues a pass after matchmaking or room allocation,
// and the room re-issues one to each seated member while it is alive; the
// Worker verifies it before any request reaches a room.

export const ADMISSION_PASS_TTL_MS = 10 * 60 * 1000;

// Passes are signed with a key derived from BETTER_AUTH_SECRET, never with the
// secret itself: that one signs sessions, and a key used for two purposes lets
// a signature minted for one be presented to the other.
const KEY_INFO = "arithmetic-racer/room-admission-pass/v1";

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

async function keyFor(env) {
  const secret = env?.BETTER_AUTH_SECRET;
  if (typeof secret !== "string" || secret.length < 16) return null;
  const root = await crypto.subtle.importKey("raw", text(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text(KEY_INFO) },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function issueAdmissionPass(env, roomId, mode, now = Date.now()) {
  const key = await keyFor(env);
  if (!key) throw new Error("admission pass secret is not configured");
  const payload = base64Url(text(JSON.stringify({ roomId, mode, exp: now + ADMISSION_PASS_TTL_MS })));
  const signature = await crypto.subtle.sign("HMAC", key, text(payload));
  return `v1.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export async function verifyAdmissionPass(env, pass, { roomId, mode, now = Date.now() }) {
  if (typeof pass !== "string") return false;
  const key = await keyFor(env);
  if (!key) return false;
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
    return await crypto.subtle.verify("HMAC", key, signature, text(parts[1]));
  } catch {
    return false;
  }
}
