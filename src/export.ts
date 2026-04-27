import { createWriteStream } from "fs";
import { createGzip } from "zlib";
import { db } from "./lib/db";
import { VERSION } from "./lib/constants";

interface Opts {
  out: string;
  channel?: string;
  since?: string;
  until?: string;
  date?: string;
  types: Set<string>;
}

function parseArgs(args: string[]): Opts {
  let out = "";
  let channel: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let date: string | undefined;
  const types = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "-o") out = args[++i];
    else if (a === "--channel") channel = args[++i];
    else if (a === "--since") since = args[++i];
    else if (a === "--until") until = args[++i];
    else if (a === "--date") date = args[++i];
    else if (a === "--type") types.add(args[++i]);
  }
  if (date) {
    const d = date === "today"
      ? new Date().toISOString().slice(0, 10)
      : date;
    since = `${d}T00:00:00.000Z`;
    until = `${d}T23:59:59.999Z`;
    if (!out) out = `tunr-export-${d}.jsonl.gz`;
  }
  if (!out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    out = `tunr-export-${stamp}.jsonl.gz`;
  }
  if (types.size === 0) {
    types.add("channels");
    types.add("screen");
    types.add("audio");
    types.add("ingested");
  }
  return { out, channel, since, until, date, types };
}

export async function runExport(args: string[]) {
  const opts = parseArgs(args);
  const sinceIso = opts.since
    ? new Date(opts.since).toISOString()
    : "1970-01-01T00:00:00.000Z";
  const untilIso = opts.until
    ? new Date(opts.until).toISOString()
    : "9999-12-31T23:59:59.999Z";

  const file = createWriteStream(opts.out);
  const gz = createGzip();
  gz.pipe(file);
  let writeError: Error | null = null;
  gz.on("error", (e) => { writeError = e; });

  const write = (obj: unknown) =>
    new Promise<void>((resolve, reject) => {
      if (writeError) return reject(writeError);
      if (gz.write(JSON.stringify(obj) + "\n")) resolve();
      else gz.once("drain", () => resolve());
    });

  let total = 0;

  await write({
    tunr_export: 1,
    exportedAt: new Date().toISOString(),
    version: VERSION,
    filters: { channel: opts.channel ?? null, since: sinceIso, until: untilIso, types: [...opts.types] },
  });

  if (opts.types.has("channels")) {
    const rows = db
      .prepare(`SELECT name, include_audio FROM channels${opts.channel ? ` WHERE name = ?` : ``}`)
      .all(...(opts.channel ? [opts.channel] : [])) as any[];
    for (const r of rows) {
      await write({ table: "channels", row: r });
      total++;
    }
  }

  if (opts.types.has("screen")) {
    let sql = `SELECT timestamp, pid, window_index, app, window_title, texts, channel_names, window_id, diff_text FROM screen_states WHERE timestamp > ? AND timestamp <= ?`;
    const params: any[] = [sinceIso, untilIso];
    if (opts.channel) {
      sql += ` AND channel_names LIKE ?`;
      params.push(`%${opts.channel}%`);
    }
    sql += ` ORDER BY timestamp ASC`;
    for (const r of db.prepare(sql).iterate(...params) as any) {
      await write({ table: "screen_states", row: r });
      total++;
    }
  }

  if (opts.types.has("audio")) {
    const sql = `SELECT timestamp, audio_path, transcript FROM audio_transcripts WHERE timestamp > ? AND timestamp <= ? ORDER BY timestamp ASC`;
    for (const r of db.prepare(sql).iterate(sinceIso, untilIso) as any) {
      await write({ table: "audio_transcripts", row: r });
      total++;
    }
  }

  if (opts.types.has("ingested")) {
    let sql = `SELECT timestamp, source, channel_name, text, meta FROM ingested WHERE timestamp > ? AND timestamp <= ?`;
    const params: any[] = [sinceIso, untilIso];
    if (opts.channel) {
      sql += ` AND channel_name = ?`;
      params.push(opts.channel);
    }
    sql += ` ORDER BY timestamp ASC`;
    for (const r of db.prepare(sql).iterate(...params) as any) {
      await write({ table: "ingested", row: r });
      total++;
    }
  }

  await new Promise<void>((resolve, reject) => {
    gz.end(() => resolve());
    gz.once("error", reject);
  });
  await new Promise<void>((resolve) => file.on("close", resolve));

  console.log(`Exported ${total} records to ${opts.out}`);
}
