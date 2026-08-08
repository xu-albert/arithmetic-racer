// Tests for the User-Agent describer used to label bug reports.
//
// These pin the ordering traps rather than aiming for coverage of every
// browser: the failure mode this file exists to prevent is "every Chromium
// browser reports Chrome" and "every Android device reports Linux".

import { describe, it, expect } from "vitest";
import { describeUserAgent } from "./user-agent.js";

const UAS = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
  firefoxIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15",
  edgeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/131.0.0.0 Mobile/15E148 Safari/605.1.15",
  androidWebview:
    "Mozilla/5.0 (Linux; Android 14; SM-A155F) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  firefoxWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  samsungAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36",
  operaLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0",
  chromeOS:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  firefoxLinux:
    "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
};

describe("describeUserAgent — browser", () => {
  it("names Chrome with its major version", () => {
    expect(describeUserAgent(UAS.chromeMac).browser).toBe("Chrome 141");
  });

  it("names Safari from Version/, not the WebKit build in Safari/", () => {
    expect(describeUserAgent(UAS.safariMac).browser).toBe("Safari 18");
  });

  it("names Safari on iPhone, where Mobile/ sits between Version/ and Safari/", () => {
    expect(describeUserAgent(UAS.safariIphone).browser).toBe("Safari 18");
  });

  it("names Safari on iPad", () => {
    expect(describeUserAgent(UAS.safariIpad).browser).toBe("Safari 18");
  });

  it("does not call Firefox on iOS 'Safari'", () => {
    // Every iOS browser is WebKit and carries a Safari/ token, so the Safari
    // branch has to stay behind the ones that name themselves.
    expect(describeUserAgent(UAS.firefoxIphone).browser).toBe("Firefox 133");
  });

  it("does not call Edge on iOS 'Safari' even though it sends Version/ too", () => {
    expect(describeUserAgent(UAS.edgeIphone).browser).toBe("Edge 131");
  });

  it("does not call an Android WebView's Version/4.0 'Safari 4'", () => {
    expect(describeUserAgent(UAS.androidWebview).browser).toBe("Chrome 141");
  });

  it("does not call Edge 'Chrome'", () => {
    // Every Chromium UA contains "Chrome/". Ordering is the whole test.
    expect(describeUserAgent(UAS.edgeWin).browser).toBe("Edge 141");
  });

  it("does not call Opera 'Chrome'", () => {
    expect(describeUserAgent(UAS.operaLinux).browser).toBe("Opera 125");
  });

  it("does not call Samsung Internet 'Chrome'", () => {
    expect(describeUserAgent(UAS.samsungAndroid).browser).toBe("Samsung Internet 27");
  });

  it("names Chrome on iOS (CriOS) as Chrome, not Safari", () => {
    expect(describeUserAgent(UAS.chromeIphone).browser).toBe("Chrome 141");
  });

  it("names Firefox", () => {
    expect(describeUserAgent(UAS.firefoxWin).browser).toBe("Firefox 135");
  });
});

describe("describeUserAgent — OS", () => {
  it.each([
    ["chromeMac", "macOS"],
    ["safariIphone", "iOS"],
    ["chromeIphone", "iOS"],
    ["firefoxWin", "Windows 10/11"],
    ["edgeWin", "Windows 10/11"],
    ["chromeAndroid", "Android"],
    ["chromeOS", "ChromeOS"],
    ["firefoxLinux", "Linux"],
  ])("reads %s as %s", (key, expected) => {
    expect(describeUserAgent(UAS[key]).os).toBe(expected);
  });

  it("does not call Android 'Linux'", () => {
    // Android UAs start "Mozilla/5.0 (Linux; Android ...".
    expect(describeUserAgent(UAS.chromeAndroid).os).not.toBe("Linux");
  });

  it("does not call ChromeOS 'Linux'", () => {
    expect(describeUserAgent(UAS.chromeOS).os).not.toBe("Linux");
  });
});

describe("describeUserAgent — hostile and missing input", () => {
  it.each([[undefined], [null], [""], [42], [{}], [[]]])(
    "returns nulls rather than throwing for %p",
    (input) => {
      expect(describeUserAgent(input)).toEqual({ browser: null, os: null });
    }
  );

  it("returns nulls for an unrecognized agent", () => {
    // curl, a scanner, a browser that does not exist yet. Not an error — the
    // raw UA is stored alongside this for exactly these cases.
    expect(describeUserAgent("curl/8.7.1")).toEqual({ browser: null, os: null });
  });

  it("never throws on adversarial input", () => {
    expect(() => describeUserAgent("Chrome/".repeat(5000))).not.toThrow();
    expect(() => describeUserAgent("(((((((((((")).not.toThrow();
  });
});
