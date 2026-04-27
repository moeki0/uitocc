import { createReadStream } from "fs";
import { createGunzip } from "zlib";
import { createInterface } from "readline";
import { db } from "./lib/db";

export async function runImport(args: string[]) {
  const path = args[0];
  if (!path) {
    console.error("Usage: tunr import <path.jsonl.gz>");
    process.exit(1);
  }

  const stream = path.endsWith(".gz")
    ? createReadStream(path).pipe(createGunzip())
    : createReadStream(path);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const insertChannel = db.prepare(
    `INSERT OR IGNORE INTO channels (name, include_audio) VALUES (?, ?)`
  );
  const insertScreen = db.prepare(
    `INSERT OR IGNORE INTO screen_states (timestamp, pid, window_index, app, window_title, texts, channel_names, window_id, diff_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    for await (const line of rl) {
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
        case "screen_states":
          insertScreen.run(
            row.timestamp,
            row.pid,
            row.window_index,
            row.app,
            row.window_title,
            row.texts,
            row.channel_names ?? null,
            row.window_id ?? 0,
            row.diff_text ?? null
          );
          break;
        case "audio_transcripts":
          insertAudio.run(row.timestamp, row.audio_path, row.transcript, row.source ?? "system");
          break;
        case "ingested":
          insertIngested.run(
            row.timestamp,
            row.source,
            row.channel_name ?? null,
            row.text,
            row.meta ?? null
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

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Imported ${total} records from ${path}`);
  for (const [t, c] of Object.entries(counts)) console.log(`  ${t}: ${c}`);
}
