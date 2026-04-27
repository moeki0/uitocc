import { dirname, join } from "path";
import type { WindowInfo } from "./types";

const PROJECT_DIR = join(import.meta.dir, "../..");

const AX_TEXT_PATH = join(dirname(process.execPath), "tunr-ax-text");
const AX_TEXT_FALLBACK = join(PROJECT_DIR, "tunr-ax-text");
export const axTextBin = await Bun.file(AX_TEXT_PATH).exists() ? AX_TEXT_PATH : AX_TEXT_FALLBACK;

const EMBED_PATH = join(dirname(process.execPath), "tunr-embed");
const EMBED_FALLBACK = join(PROJECT_DIR, "tunr-embed");
export const embedBin = await Bun.file(EMBED_PATH).exists() ? EMBED_PATH : EMBED_FALLBACK;

export async function generateEmbedding(text: string): Promise<Buffer | null> {
  try {
    const proc = Bun.spawn([embedBin], {
      stdin: new TextEncoder().encode(text),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const stdout = await new Response(proc.stdout).text();
    const vec: number[] = JSON.parse(stdout.trim());
    const buf = Buffer.alloc(vec.length * 8);
    for (let i = 0; i < vec.length; i++) buf.writeDoubleBE(vec[i], i * 8);
    return buf;
  } catch {
    return null;
  }
}

export function generateEmbeddingSync(text: string): Buffer | null {
  // Sync variant for one-shot CLI tools (send, ingest) where the process
  // exits right after; blocking is fine there.
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
    const proc = Bun.spawn([axTextBin, "--all"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];
    const out = (await new Response(proc.stdout).text()).trim();
    if (!out) return [];
    return JSON.parse(out);
  } catch {
    return [];
  }
}

export function windowKey(w: { pid: number; window_index: number; window_id?: number }): string {
  // Prefer CGWindowID (stable) over window_index (array position, can shift)
  if (w.window_id) return `wid:${w.window_id}`;
  return `${w.pid}:${w.window_index}`;
}
