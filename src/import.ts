import { createReadStream } from "fs";
import { createGunzip } from "zlib";
import { createInterface } from "readline";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { db } from "./lib/db";
import { SCREENSHOT_DIR } from "./lib/constants";

async function importLines(linesIter: AsyncIterable<string>, screenshotMap: Map<string, string>): Promise<Record<string, number>> {
  const insertChannel = db.prepare(
    `INSERT OR IGNORE INTO channels (name, include_audio) VALUES (?, ?)`
  );
  const insertScreen = db.prepare(
    `INSERT OR IGNORE INTO screen_states (timestamp, pid, window_index, app, window_title, texts, channel_names, window_id, diff_text, screenshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAudio = db.prepare(
    `INSERT OR IGNORE INTO audio_transcripts (timestamp, audio_path, transcript, source) VALUES (?, ?, ?, ?)`
  );
  const insertIngested = db.prepare(
    `INSERT OR IGNORE INTO ingested (timestamp, source, channel_name, text, meta) VALUES (?, ?, ?, ?, ?)`
  );

  const counts: Record<string, number> = {};
  let header: any = null;

  db.run("BEGIN");
  try {
    for await (const line of linesIter) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (!header) {
        if (!obj.tunr_export) throw new Error("missing tunr_export header");
        header = obj;
        continue;
      }
      const { table, row } = obj;
      switch (table) {
        case "channels":
          insertChannel.run(row.name, row.include_audio ?? 0);
          break;
        case "screen_states": {
          let shot: string | null = row.screenshot_path ?? null;
          if (shot && screenshotMap.has(shot)) shot = screenshotMap.get(shot)!;
          insertScreen.run(
            row.timestamp,
            row.pid,
            row.window_index,
            row.app,
            row.window_title,
            row.texts,
            row.channel_names ?? null,
            row.window_id ?? 0,
            row.diff_text ?? null,
            shot,
          );
          break;
        }
        case "audio_transcripts":
          insertAudio.run(row.timestamp, row.audio_path, row.transcript, row.source ?? "system");
          break;
        case "ingested":
          insertIngested.run(
            row.timestamp,
            row.source,
            row.channel_name ?? null,
            row.text,
            row.meta ?? null,
          );
          break;
        default:
          continue;
      }
      counts[table] = (counts[table] || 0) + 1;
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
  return counts;
}

async function importTarGz(path: string): Promise<Record<string, number>> {
  const stage = mkdtempSync(join(tmpdir(), "tunr-import-"));
  try {
    const proc = Bun.spawnSync(["tar", "-xzf", path, "-C", stage], { stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`tar -xzf failed: ${proc.stderr.toString()}`);
    }

    // Copy screenshots into local SCREENSHOT_DIR; build a map from
    // archive-relative path -> local absolute path.
    const screenshotMap = new Map<string, string>();
    const stagedShotsDir = join(stage, "screenshots");
    if (existsSync(stagedShotsDir)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      for (const f of readdirSync(stagedShotsDir)) {
        const srcPath = join(stagedShotsDir, f);
        const dstPath = join(SCREENSHOT_DIR, f);
        if (!existsSync(dstPath)) copyFileSync(srcPath, dstPath);
        screenshotMap.set(`screenshots/${f}`, dstPath);
      }
    }

    const dataPath = join(stage, "data.jsonl");
    const stream = createReadStream(dataPath);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    return await importLines(rl, screenshotMap);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function importJsonlGz(path: string): Promise<Record<string, number>> {
  const stream = path.endsWith(".gz")
    ? createReadStream(path).pipe(createGunzip())
    : createReadStream(path);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  return await importLines(rl, new Map());
}

export async function runImport(args: string[]) {
  const path = args[0];
  if (!path) {
    console.error("Usage: tunr import <path.tar.gz | path.jsonl.gz>");
    process.exit(1);
  }

  const counts = path.endsWith(".tar.gz") || path.endsWith(".tgz")
    ? await importTarGz(path)
    : await importJsonlGz(path);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Imported ${total} records from ${basename(path)}`);
  for (const [t, c] of Object.entries(counts)) console.log(`  ${t}: ${c}`);
}
