export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Decodes a big-endian Float64 BLOB (as written by capture.generateEmbedding)
// into a Float64Array.
export function blobToFloat64Array(blob: Uint8Array | Buffer): Float64Array {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const arr = new Float64Array(blob.byteLength / 8);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = view.getFloat64(i * 8, false); // big-endian
  }
  return arr;
}
