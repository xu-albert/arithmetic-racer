// User-Agent → a short "Chrome 141" / "macOS" description, for bug reports.
//
// Deliberately not a UA-parsing library. The job is to save an operator from
// decoding a 130-character string in the dashboard, and the raw UA is stored
// next to the result for anything this gets wrong — so being approximate is
// acceptable, while adding a dependency (and its update treadmill) for a
// cosmetic label is not.
//
// Order matters in both tables: every Chromium browser also says "Chrome", and
// every Android UA also says "Linux", so the specific patterns are listed
// before the general ones and the first match wins.

const BROWSERS = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, "Edge"],
  [/\bOPR\/(\d+)/, "Opera"],
  [/\bSamsungBrowser\/(\d+)/, "Samsung Internet"],
  [/\bFxiOS\/(\d+)/, "Firefox"],
  [/\bFirefox\/(\d+)/, "Firefox"],
  [/\bCriOS\/(\d+)/, "Chrome"],
  [/\bChrome\/(\d+)/, "Chrome"],
  // Safari reports its own version in `Version/`; the `Safari/` token alone is
  // a WebKit build number and is present in most of the above too, so a
  // `Safari/` token still has to appear — but anywhere later, not adjacent.
  // iOS Safari puts `Mobile/15E148` between the two.
  [/\bVersion\/(\d+)(?=.* Safari\/)/, "Safari"],
];

const OSES = [
  [/Windows NT 10\.0/, "Windows 10/11"],
  [/Windows NT/, "Windows"],
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bAndroid\b/, "Android"],
  [/Mac OS X/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * @param {unknown} ua A User-Agent string, or anything at all.
 * @returns {{ browser: string|null, os: string|null }} Nulls where unrecognized
 *   — an unknown UA is a normal outcome (curl, a new browser, a stripped
 *   header), not an error, and must never throw inside a submit path.
 */
export function describeUserAgent(ua) {
  if (typeof ua !== "string" || ua === "") return { browser: null, os: null };

  let browser = null;
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(ua);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }

  let os = null;
  for (const [pattern, name] of OSES) {
    if (pattern.test(ua)) {
      os = name;
      break;
    }
  }

  return { browser, os };
}
