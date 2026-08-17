// Display helpers for race rows, shared by every screen that renders them.
//
// Extracted from profile.js when the lobby leaderboard needed the same three
// formatters: PPM, points, and a relative timestamp have to read identically
// wherever they appear, and two copies of "one decimal" is exactly how they
// stop doing that. `escapeHtml` moved here for the stronger version of that
// argument — every caller interpolates a server-supplied username into
// innerHTML, and a second copy is a copy that a hardening fix can miss.
// profile.js re-exports all of them through its `_internals` so its existing
// tests keep addressing them where they always did.

/**
 * Format problems-per-minute — the headline speed number. One decimal, because
 * PPM ranges roughly 10–40 here and whole numbers would hide real improvement.
 */
export function fmtPpm(ppm) {
  if (ppm == null || !Number.isFinite(ppm)) return "—";
  return ppm.toFixed(1);
}

/**
 * Format a race score. Points are stored unrounded; rounding is display-only.
 * One decimal, because a single race lands around 0.4–5 points and whole
 * numbers would both collapse the column and stop the rows adding up to the
 * tier total. Grouping separators keep large tier totals readable.
 */
export function fmtPoints(points) {
  if (points == null || !Number.isFinite(points)) return "—";
  return points.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * Escape text for interpolation into innerHTML. The single canonical copy: the
 * profile's race table and the lobby leaderboard both put a username straight
 * into markup, and that name arrives over the wire.
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Coarse "h ago" / "d ago" relative timestamp. */
export function fmtRelative(iso) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "—";
  const diff = Date.now() - d;
  const h = Math.round(diff / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}
