// Signed admission passes keep a room name from being a room credential. The
// Worker issues a pass after matchmaking or room allocation and checks it on
// every request to a room. A pass is what a new seat needs; a seat already
// held needs none. Its short expiry bounds only what a pass may create: an
// expired pass still joins a room that is alive, but never creates or revives
// one (RaceRoom.fetch and handleHello in ./room.js).

export const ADMISSION_PASS_TTL_MS = 10 * 60 * 1000;

// Set by the Worker on every request it lets through to a room, overwriting
// whatever the client sent: the pass's verdict, 'fresh', 'stale' or 'none'.
export const ADMISSION_HEADER = "x-arithmetic-admission";

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

/**
 * 'fresh' for a pass signed for this room and mode that has not expired,
 * 'stale' for one that has, or null for anything else — a forgery, another
 * room's or mode's pass, or no pass at all.
 */
export async function checkAdmissionPass(env, pass, { roomId, mode, now = Date.now() }) {
  if (typeof pass !== "string") return null;
  const key = await keyFor(env);
  if (!key) return null;
  const parts = pass.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  let payload;
  let signature;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    signature = decodeBase64Url(parts[2]);
  } catch {
    return null;
  }
  if (!payload || payload.roomId !== roomId || payload.mode !== mode || !Number.isFinite(payload.exp)) {
    return null;
  }
  let authentic;
  try {
    authentic = await crypto.subtle.verify("HMAC", key, signature, text(parts[1]));
  } catch {
    return null;
  }
  if (!authentic) return null;
  return payload.exp > now ? "fresh" : "stale";
}
