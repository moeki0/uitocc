import { describe, expect, test } from "bun:test";
import { computeDiffLines } from "./diff";

describe("computeDiffLines", () => {
  test("returns empty when nothing changed", () => {
    expect(computeDiffLines(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  });

  test("returns only inserted lines", () => {
    expect(computeDiffLines(["a", "b"], ["a", "X", "b"])).toEqual(["X"]);
  });

  test("returns lines added at the end", () => {
    expect(computeDiffLines(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
  });

  test("returns lines added at the start", () => {
    expect(computeDiffLines(["a", "b"], ["X", "a", "b"])).toEqual(["X"]);
  });

  test("ignores deletions (returns nothing for pure removal)", () => {
    expect(computeDiffLines(["a", "b", "c"], ["a", "c"])).toEqual([]);
  });

  test("returns the new line on substitution", () => {
    expect(computeDiffLines(["a", "b", "c"], ["a", "X", "c"])).toEqual(["X"]);
  });

  test("first capture from empty returns all lines", () => {
    expect(computeDiffLines([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  test("identical duplicate lines on both sides yield no diff", () => {
    expect(computeDiffLines(["a", "a", "a"], ["a", "a", "a"])).toEqual([]);
  });

  test("preserves order of multiple insertions", () => {
    expect(computeDiffLines(["a", "d"], ["a", "b", "c", "d"])).toEqual(["b", "c"]);
  });
});
