import { describe, expect, test } from "bun:test";
import { globMatch, isDenied } from "./deny";

describe("globMatch", () => {
  test("exact match without wildcards", () => {
    expect(globMatch("hello", "hello")).toBe(true);
    expect(globMatch("hello", "world")).toBe(false);
  });

  test("trailing wildcard", () => {
    expect(globMatch("hello*", "hello world")).toBe(true);
    expect(globMatch("hello*", "hi world")).toBe(false);
  });

  test("leading wildcard", () => {
    expect(globMatch("*world", "hello world")).toBe(true);
    expect(globMatch("*world", "hello there")).toBe(false);
  });

  test("middle wildcard", () => {
    expect(globMatch("foo*bar", "foo XYZ bar")).toBe(true);
    expect(globMatch("foo*bar", "foo bar")).toBe(true);
    expect(globMatch("foo*bar", "foo")).toBe(false);
  });

  test("multiple wildcards in order", () => {
    expect(globMatch("a*b*c", "axxbxxc")).toBe(true);
    expect(globMatch("a*b*c", "acb")).toBe(false);
  });

  test("bare wildcard matches anything", () => {
    expect(globMatch("*", "")).toBe(true);
    expect(globMatch("*", "anything")).toBe(true);
  });
});

describe("isDenied", () => {
  test("empty deny list never denies", () => {
    expect(isDenied([], "Chrome", "Gmail", ["https://mail.google.com"])).toBe(false);
  });

  test("rule with no fields never denies (must specify at least one)", () => {
    expect(isDenied([{}], "Chrome", "Gmail", [])).toBe(false);
  });

  test("app-only rule matches the app", () => {
    expect(isDenied([{ app: "Chrome" }], "Chrome", "anything", [])).toBe(true);
    expect(isDenied([{ app: "Chrome" }], "Safari", "anything", [])).toBe(false);
  });

  test("title-only rule matches by title glob", () => {
    expect(isDenied([{ title: "*Bank*" }], "Chrome", "Online Bank Login", [])).toBe(true);
    expect(isDenied([{ title: "*Bank*" }], "Chrome", "GitHub", [])).toBe(false);
  });

  test("url-only rule matches if any URL globs", () => {
    expect(isDenied([{ url: "https://*.bank.com/*" }], "Chrome", "X", ["https://login.bank.com/auth"])).toBe(true);
    expect(isDenied([{ url: "https://*.bank.com/*" }], "Chrome", "X", ["https://github.com"])).toBe(false);
  });

  test("multi-field rule requires ALL fields to match (AND logic)", () => {
    const rule = { app: "Chrome", title: "*Bank*" };
    expect(isDenied([rule], "Chrome", "My Bank", [])).toBe(true);
    expect(isDenied([rule], "Safari", "My Bank", [])).toBe(false);
    expect(isDenied([rule], "Chrome", "GitHub", [])).toBe(false);
  });

  test("multiple rules: any matching rule denies (OR logic across rules)", () => {
    const rules = [{ app: "Slack" }, { title: "*secret*" }];
    expect(isDenied(rules, "Slack", "X", [])).toBe(true);
    expect(isDenied(rules, "Chrome", "top secret notes", [])).toBe(true);
    expect(isDenied(rules, "Chrome", "GitHub", [])).toBe(false);
  });
});
