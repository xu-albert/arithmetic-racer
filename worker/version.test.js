// Tests for the two version values a bug report can record.
//
// The point of deployId() is that it is *not* a constant: package.json's
// version is bumped by hand and never has been, so only the Worker Version id
// can say which deploy a reporter was on. These assert the binding is actually
// wired up (a missing `version_metadata` entry in wrangler.jsonc fails the
// first test, which is the failure mode worth catching) and that an absent
// binding degrades to null rather than to a made-up id.

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { APP_VERSION, deployId } from "./version.js";

describe("APP_VERSION", () => {
  it("is package.json's version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("deployId", () => {
  it("reads the Worker Version id from the version_metadata binding", () => {
    // Not compared against a literal: the id changes with every deploy, which
    // is the entire reason it is recorded. Locally the runtime mints one per
    // run, so the binding's own value is the only honest expectation.
    expect(env.CF_VERSION_METADATA?.id).toBeTruthy();
    expect(deployId(env)).toBe(env.CF_VERSION_METADATA.id);
  });

  it("is null when the binding is missing, undefined, or empty", () => {
    // A build deployed before wrangler.jsonc declared the binding still runs;
    // it must record no deploy id rather than a stand-in for one.
    expect(deployId({})).toBe(null);
    expect(deployId(undefined)).toBe(null);
    expect(deployId({ CF_VERSION_METADATA: undefined })).toBe(null);
    expect(deployId({ CF_VERSION_METADATA: { id: "" } })).toBe(null);
    expect(deployId({ CF_VERSION_METADATA: { id: 123 } })).toBe(null);
  });
});
