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

function checkAdminToken(url, env) {
  const got = url.searchParams.get("token") ?? "";
  const want = env.ADMIN_TOKEN ?? "";
  if (!timingSafeEqualStrings(got, want)) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function html(strings, ...values) {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (Array.isArray(v)) out += v.join("");
      else if (v && typeof v === "object" && v.__html) out += v.__html;
      else out += escapeHtml(v ?? "");
    }
  }
  return out;
}

function raw(s) {
  return { __html: s };
}

export async function handleAdminIndex(request, env) {
  const url = new URL(request.url);
  const gateResponse = checkAdminToken(url, env);
  if (gateResponse) return gateResponse;

  const body = html`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Arithmetic Racer · admin</title>
        <style>
          body { font: 14px/1.4 system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #222; }
          h1 { font-size: 1.4rem; }
          .empty { color: #888; font-style: italic; }
        </style>
      </head>
      <body>
        <h1>Arithmetic Racer · admin</h1>
        <p class="empty">No data yet.</p>
      </body>
    </html>
  `;
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
