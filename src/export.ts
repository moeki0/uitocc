import { createWriteStream } from "fs";
import { createGzip } from "zlib";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, basename } from "path";
import { db } from "./lib/db";
import { VERSION } from "./lib/constants";

interface Opts {
  out: string;
  channel?: string;
  since?: string;
  until?: string;
  date?: string;
  types: Set<string>;
  format: "jsonl.gz" | "tar.gz";
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
    if (!out) out = `tunr-export-${d}.tar.gz`;
  }
  if (!out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    out = `tunr-export-${stamp}.tar.gz`;
  }
  if (types.size === 0) {
    types.add("channels");
    types.add("screen");
    types.add("audio");
    types.add("ingested");
  }
  const format: Opts["format"] = out.endsWith(".tar.gz") || out.endsWith(".tgz") ? "tar.gz" : "jsonl.gz";
  return { out, channel, since, until, date, types, format };
}

interface ExportRow { table: string; row: any }

function* collectRows(opts: Opts, sinceIso: string, untilIso: string): Generator<ExportRow> {
  if (opts.types.has("channels")) {
    const rows = db
      .prepare(`SELECT name, include_audio FROM channels${opts.channel ? ` WHERE name = ?` : ``}`)
      .all(...(opts.channel ? [opts.channel] : [])) as any[];
    for (const r of rows) yield { table: "channels", row: r };
  }
  if (opts.types.has("screen")) {
    let sql = `SELECT timestamp, pid, window_index, app, window_title, texts, channel_names, window_id, diff_text, screenshot_path FROM screen_states WHERE timestamp > ? AND timestamp <= ?`;
    const params: any[] = [sinceIso, untilIso];
    if (opts.channel) {
      sql += ` AND channel_names LIKE ?`;
      params.push(`%${opts.channel}%`);
    }
    sql += ` ORDER BY timestamp ASC`;
    for (const r of db.prepare(sql).iterate(...params) as any) yield { table: "screen_states", row: r };
  }
  if (opts.types.has("audio")) {
    const sql = `SELECT timestamp, audio_path, transcript, source FROM audio_transcripts WHERE timestamp > ? AND timestamp <= ? ORDER BY timestamp ASC`;
    for (const r of db.prepare(sql).iterate(sinceIso, untilIso) as any) yield { table: "audio_transcripts", row: r };
  }
  if (opts.types.has("ingested")) {
    let sql = `SELECT timestamp, source, channel_name, text, meta FROM ingested WHERE timestamp > ? AND timestamp <= ?`;
    const params: any[] = [sinceIso, untilIso];
    if (opts.channel) {
      sql += ` AND channel_name = ?`;
      params.push(opts.channel);
    }
    sql += ` ORDER BY timestamp ASC`;
    for (const r of db.prepare(sql).iterate(...params) as any) yield { table: "ingested", row: r };
  }
}

function buildHeader(opts: Opts, sinceIso: string, untilIso: string) {
  return {
    tunr_export: 1,
    exportedAt: new Date().toISOString(),
    version: VERSION,
    filters: { channel: opts.channel ?? null, since: sinceIso, until: untilIso, types: [...opts.types] },
  };
}

async function exportJsonlGz(opts: Opts, sinceIso: string, untilIso: string): Promise<number> {
  const file = createWriteStream(opts.out);
  const gz = createGzip();
  gz.pipe(file);
  const write = (obj: unknown) =>
    new Promise<void>((resolve) => {
      if (gz.write(JSON.stringify(obj) + "\n")) resolve();
      else gz.once("drain", () => resolve());
    });
  let total = 0;
  await write(buildHeader(opts, sinceIso, untilIso));
  for (const rec of collectRows(opts, sinceIso, untilIso)) {
    await write(rec);
    total++;
  }
  await new Promise<void>((resolve, reject) => {
    gz.end(() => resolve());
    gz.once("error", reject);
  });
  await new Promise<void>((resolve) => file.on("close", resolve));
  return total;
}

async function exportTarGz(opts: Opts, sinceIso: string, untilIso: string): Promise<number> {
  const stage = mkdtempSync(join(tmpdir(), "tunr-export-"));
  try {
    const shotsDir = join(stage, "screenshots");
    mkdirSync(shotsDir, { recursive: true });

    const lines: string[] = [];
    lines.push(JSON.stringify(buildHeader(opts, sinceIso, untilIso)));
    let total = 0;
    for (const rec of collectRows(opts, sinceIso, untilIso)) {
      if (rec.table === "screen_states" && rec.row.screenshot_path) {
        const src = rec.row.screenshot_path as string;
        if (existsSync(src)) {
          const name = basename(src);
          copyFileSync(src, join(shotsDir, name));
          rec.row.screenshot_path = `screenshots/${name}`;
        } else {
          rec.row.screenshot_path = null;
        }
      }
      lines.push(JSON.stringify(rec));
      total++;
    }
    writeFileSync(join(stage, "data.jsonl"), lines.join("\n") + "\n");

    const proc = Bun.spawnSync(["tar", "-czf", opts.out, "-C", stage, "data.jsonl", "screenshots"], { stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`tar failed: ${proc.stderr.toString()}`);
    }
    return total;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function runExport(args: string[]) {
  const opts = parseArgs(args);
  const sinceIso = opts.since ? new Date(opts.since).toISOString() : "1970-01-01T00:00:00.000Z";
  const untilIso = opts.until ? new Date(opts.until).toISOString() : "9999-12-31T23:59:59.999Z";

  const total = opts.format === "tar.gz"
    ? await exportTarGz(opts, sinceIso, untilIso)
    : await exportJsonlGz(opts, sinceIso, untilIso);

  console.log(`Exported ${total} records to ${opts.out}`);
}
