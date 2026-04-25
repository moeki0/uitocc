import { dirname, join } from "path";
import type { WindowInfo } from "./types";

const PROJECT_DIR = join(import.meta.dir, "../..");

const AX_TEXT_PATH = join(dirname(process.execPath), "tunr-ax-text");
const AX_TEXT_FALLBACK = join(PROJECT_DIR, "tunr-ax-text");
export const axTextBin = await Bun.file(AX_TEXT_PATH).exists() ? AX_TEXT_PATH : AX_TEXT_FALLBACK;

const EMBED_PATH = join(dirname(process.execPath), "tunr-embed");
const EMBED_FALLBACK = join(PROJECT_DIR, "tunr-embed");
export const embedBin = await Bun.file(EMBED_PATH).exists() ? EMBED_PATH : EMBED_FALLBACK;

export function generateEmbedding(text: string): Buffer | null {
  try {
    const proc = Bun.spawnSync([embedBin], {
      stdin: new TextEncoder().encode(text),
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const vec: number[] = JSON.parse(proc.stdout.toString().trim());
    const buf = Buffer.alloc(vec.length * 8);
    for (let i = 0; i < vec.length; i++) buf.writeDoubleBE(vec[i], i * 8);
    return buf;
  } catch {
    return null;
  }
}

export async function getAllWindows(): Promise<WindowInfo[]> {
  try {
    const proc = Bun.spawnSync([axTextBin, "--all"], { stderr: "pipe" });
    if (proc.exitCode !== 0) return [];
    const out = proc.stdout.toString().trim();
    if (!out) return [];
    return JSON.parse(out);
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: Buffer, b: Buffer): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i += 8) {
    const va = a.readDoubleBE(i);
    const vb = b.readDoubleBE(i);
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function windowKey(w: { pid: number; window_index: number }): string {
  return `${w.pid}:${w.window_index}`;
}
