import { describe, expect, test } from "bun:test";
import { parseIngestArgs } from "./ingest-args";

describe("parseIngestArgs", () => {
  test("parses --source", () => {
    expect(parseIngestArgs(["--source", "git"])).toEqual({ source: "git", channel: null, meta: {} });
  });

  test("parses --channel", () => {
    expect(parseIngestArgs(["--source", "git", "--channel", "dev"])).toEqual({
      source: "git", channel: "dev", meta: {},
    });
  });

  test("parses --meta key=value", () => {
    expect(parseIngestArgs(["--source", "git", "--meta", "repo=tunr"]).meta).toEqual({ repo: "tunr" });
  });

  test("--meta value containing '=' keeps everything after the first '='", () => {
    expect(parseIngestArgs(["--source", "x", "--meta", "url=https://x.test/?q=1"]).meta).toEqual({
      url: "https://x.test/?q=1",
    });
  });

  test("multiple --meta accumulate", () => {
    const out = parseIngestArgs(["--source", "x", "--meta", "a=1", "--meta", "b=2"]);
    expect(out.meta).toEqual({ a: "1", b: "2" });
  });

  test("--meta without '=' is ignored", () => {
    expect(parseIngestArgs(["--source", "x", "--meta", "novalue"]).meta).toEqual({});
  });

  test("--meta with empty key is ignored (eq must be > 0)", () => {
    expect(parseIngestArgs(["--source", "x", "--meta", "=value"]).meta).toEqual({});
  });

  test("missing --source yields empty string (caller validates)", () => {
    expect(parseIngestArgs([]).source).toBe("");
  });

  test("unknown flags are silently ignored", () => {
    expect(parseIngestArgs(["--source", "git", "--bogus", "x"])).toEqual({
      source: "git", channel: null, meta: {},
    });
  });
});
