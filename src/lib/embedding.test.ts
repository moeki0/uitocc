import { describe, expect, test } from "bun:test";
import { cosineSimilarity, blobToFloat64Array } from "./embedding";

describe("cosineSimilarity", () => {
  test("identical unit vectors → 1", () => {
    const v = new Float64Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  test("orthogonal vectors → 0", () => {
    expect(cosineSimilarity(new Float64Array([1, 0]), new Float64Array([0, 1]))).toBeCloseTo(0);
  });

  test("opposite vectors → -1", () => {
    expect(cosineSimilarity(new Float64Array([1, 0]), new Float64Array([-1, 0]))).toBeCloseTo(-1);
  });

  test("magnitude is normalized away", () => {
    const a = new Float64Array([3, 4]);
    const b = new Float64Array([6, 8]); // same direction, double magnitude
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
  });
});

describe("blobToFloat64Array", () => {
  test("round-trips big-endian Float64 buffers (matches generateEmbedding's encoding)", () => {
    const original = [1.5, -2.25, 0, 1e-300];
    const buf = Buffer.alloc(original.length * 8);
    for (let i = 0; i < original.length; i++) buf.writeDoubleBE(original[i], i * 8);
    const decoded = blobToFloat64Array(buf);
    expect(Array.from(decoded)).toEqual(original);
  });

  test("decodes from a Uint8Array slice (DataView byteOffset honored)", () => {
    const inner = Buffer.alloc(16);
    inner.writeDoubleBE(7.5, 0);
    inner.writeDoubleBE(-3.5, 8);
    const wrapper = Buffer.concat([Buffer.alloc(8), inner]).subarray(8); // offset slice
    const decoded = blobToFloat64Array(wrapper);
    expect(Array.from(decoded)).toEqual([7.5, -3.5]);
  });
});
