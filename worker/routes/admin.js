// Admin dashboard route. Token-gated `/admin/` and `/admin/users/:id`.
// One file by design — split when v2 (live rooms) lands.

/**
 * Constant-time string equality. Returns false on empty or length mismatch.
 * Uses TextEncoder + a manual XOR-reduce so we don't depend on
 * crypto.subtle.timingSafeEqual (which has different availability across
 * workerd versions).
 */
export function timingSafeEqualStrings(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const av = enc.encode(a);
  const bv = enc.encode(b);
  if (av.length !== bv.length) return false;
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}
