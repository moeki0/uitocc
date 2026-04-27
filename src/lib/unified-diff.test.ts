import { describe, expect, test } from "bun:test";
import { makeDiff } from "./unified-diff";

describe("makeDiff", () => {
  test("identical inputs produce empty string", () => {
    expect(makeDiff(["a", "b", "c"], ["a", "b", "c"])).toBe("");
  });

  test("pure insertion at end emits + line with @@ header", () => {
    const out = makeDiff(["a", "b"], ["a", "b", "c"]);
    expect(out).toContain("+c");
    expect(out).toMatch(/^@@ /m);
  });

  test("pure deletion emits - line", () => {
    const out = makeDiff(["a", "b", "c"], ["a", "c"]);
    expect(out).toContain("-b");
  });

  test("substitution emits both - and +", () => {
    const out = makeDiff(["a", "b", "c"], ["a", "X", "c"]);
    expect(out).toContain("-b");
    expect(out).toContain("+X");
  });

  test("first capture from empty emits all new lines", () => {
    const out = makeDiff([], ["a", "b"]);
    expect(out).toContain("+a");
    expect(out).toContain("+b");
  });

  test("position header references the original (1-based) line numbers", () => {
    const out = makeDiff(["a", "b", "c", "d"], ["a", "b", "X", "d"]);
    // The change is at line 3 in the old file
    expect(out).toMatch(/@@ -3 \+\d+ @@/);
  });
});
