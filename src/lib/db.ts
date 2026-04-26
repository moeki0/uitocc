import { Database } from "bun:sqlite";
import { join } from "path";
import { DATA_DIR, DB_PATH, AUDIO_DIR } from "./constants";
import type { Capture, DayCount } from "./types";

await Bun.write(join(DATA_DIR, ".keep"), ""); // ensure dir exists

export const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode=WAL");
db.run(`CREATE TABLE IF NOT EXISTS screen_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  pid INTEGER NOT NULL,
  window_index INTEGER NOT NULL,
  app TEXT NOT NULL,
  window_title TEXT NOT NULL,
  texts TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_screen_states_timestamp ON screen_states(timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_screen_states_app ON screen_states(app)`);

try { db.run(`ALTER TABLE screen_states ADD COLUMN embedding BLOB`); } catch {}
try { db.run(`ALTER TABLE screen_states DROP COLUMN screenshot_path`); } catch {}
try { db.run(`ALTER TABLE screen_states ADD COLUMN channel_names TEXT`); } catch {}
try { db.run(`ALTER TABLE screen_states ADD COLUMN window_id INTEGER DEFAULT 0`); } catch {}
try { db.run(`ALTER TABLE screen_states ADD COLUMN diff_text TEXT`); } catch {}
try { db.run(`ALTER TABLE screen_states ADD COLUMN diff_embedding BLOB`); } catch {}

db.run(`CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  include_audio INTEGER DEFAULT 0
)`);

try { db.run(`ALTER TABLE channels DROP COLUMN rules`); } catch {}

db.run(`CREATE TABLE IF NOT EXISTS channel_subscriptions (
  channel_name TEXT PRIMARY KEY,
  subscribed_at TEXT DEFAULT (datetime('now')),
  paused INTEGER DEFAULT 0
)`);

try { db.run(`ALTER TABLE channel_subscriptions ADD COLUMN paused INTEGER DEFAULT 0`); } catch {}

await Bun.write(join(AUDIO_DIR, ".keep"), "");

db.run(`CREATE TABLE IF NOT EXISTS audio_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  audio_path TEXT NOT NULL,
  transcript TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_audio_timestamp ON audio_transcripts(timestamp)`);

export const insertAudioStmt = db.prepare(
  `INSERT INTO audio_transcripts (timestamp, audio_path, transcript) VALUES (?, ?, ?)`
);
export const insertStmt = db.prepare(
  `INSERT INTO screen_states (timestamp, pid, window_index, app, window_title, texts, embedding, channel_names, window_id, diff_text, diff_embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

db.run(`CREATE TABLE IF NOT EXISTS ingested (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  channel_name TEXT,
  text TEXT NOT NULL,
  meta TEXT,
  embedding BLOB,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_ingested_timestamp ON ingested(timestamp)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_ingested_source ON ingested(source)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_ingested_channel ON ingested(channel_name)`);

export const insertIngestedStmt = db.prepare(
  `INSERT INTO ingested (timestamp, source, channel_name, text, meta, embedding) VALUES (?, ?, ?, ?, ?, ?)`
);

export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getRecentCaptures(
  limit: number,
  typeFilter: string[],
  channelFilter: string[],
  query: string,
  timeRangeMs: number,
  audioChannels: string[],
): Capture[] {
  const captures: Capture[] = [];
  const since = timeRangeMs > 0 ? new Date(Date.now() - timeRangeMs).toISOString() : "1970-01-01T00:00:00.000Z";

  if (typeFilter.length === 0 || typeFilter.includes("screen")) {
    let sql = `SELECT id, timestamp, app, window_title, texts, channel_names FROM screen_states WHERE timestamp > ?`;
    const params: any[] = [since];
    if (channelFilter.length > 0) {
      sql += ` AND (${channelFilter.map(() => `channel_names LIKE ?`).join(" OR ")})`;
      for (const ch of channelFilter) params.push(`%${ch}%`);
    }
    if (query) {
      sql += ` AND (app LIKE ? OR window_title LIKE ? OR texts LIKE ?)`;
      params.push(`%${query}%`, `%${query}%`, `%${query}%`);
    }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    for (const r of rows) {
      const texts = JSON.parse(r.texts) as string[];
      const chans = r.channel_names ? JSON.parse(r.channel_names) : [];
      captures.push({
        id: `s${r.id}`,
        timestamp: r.timestamp,
        type: "screen",
        app: r.app,
        title: r.window_title,
        excerpt: texts.join(" ").slice(0, 80),
        fullText: texts.join("\n"),
        channels: Array.isArray(chans) ? chans : [],
      });
    }
  }

  if (typeFilter.length === 0 || typeFilter.includes("audio")) {
    let sql = `SELECT id, timestamp, transcript FROM audio_transcripts WHERE timestamp > ?`;
    const params: any[] = [since];
    if (query) {
      sql += ` AND transcript LIKE ?`;
      params.push(`%${query}%`);
    }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    for (const r of rows) {
      if (channelFilter.length > 0 && !channelFilter.some(ch => audioChannels.includes(ch))) continue;
      captures.push({
        id: `a${r.id}`,
        timestamp: r.timestamp,
        type: "audio",
        app: "Audio",
        title: "whisper",
        excerpt: r.transcript.slice(0, 80),
        fullText: r.transcript,
        channels: audioChannels,
      });
    }
  }

  if (typeFilter.length === 0 || typeFilter.includes("ingested")) {
    let sql = `SELECT id, timestamp, source, channel_name, text FROM ingested WHERE timestamp > ?`;
    const params: any[] = [since];
    if (channelFilter.length > 0) {
      sql += ` AND (${channelFilter.map(() => `channel_name = ?`).join(" OR ")})`;
      for (const ch of channelFilter) params.push(ch);
    }
    if (query) {
      sql += ` AND (source LIKE ? OR text LIKE ?)`;
      params.push(`%${query}%`, `%${query}%`);
    }
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as any[];
    for (const r of rows) {
      captures.push({
        id: `i${r.id}`,
        timestamp: r.timestamp,
        type: "ingested",
        app: `ingested:${r.source}`,
        title: r.source,
        excerpt: r.text.slice(0, 80),
        fullText: r.text,
        channels: r.channel_name ? [r.channel_name] : [],
      });
    }
  }

  captures.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return captures.slice(0, limit);
}

export function getDailyCounts(weeks: number = 16): DayCount[] {
  const days = weeks * 7;
  const since = localDateStr(new Date(Date.now() - days * 24 * 60 * 60_000));
  const screenRows = db.prepare(
    `SELECT date(timestamp, 'localtime') as d, count(*) as c FROM screen_states WHERE date(timestamp, 'localtime') >= ? GROUP BY d`
  ).all(since) as { d: string; c: number }[];
  const audioRows = db.prepare(
    `SELECT date(timestamp, 'localtime') as d, count(*) as c FROM audio_transcripts WHERE date(timestamp, 'localtime') >= ? GROUP BY d`
  ).all(since) as { d: string; c: number }[];

  const ingestedRows = db.prepare(
    `SELECT date(timestamp, 'localtime') as d, count(*) as c FROM ingested WHERE date(timestamp, 'localtime') >= ? GROUP BY d`
  ).all(since) as { d: string; c: number }[];

  const screenMap = new Map(screenRows.map(r => [r.d, r.c]));
  const audioMap = new Map(audioRows.map(r => [r.d, r.c]));
  const ingestedMap = new Map(ingestedRows.map(r => [r.d, r.c]));

  const result: DayCount[] = [];
  const startDate = new Date();
  startDate.setHours(0, 0, 0, 0);
  startDate.setDate(startDate.getDate() - days);
  for (let i = 0; i <= days; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const ds = localDateStr(d);
    const s = screenMap.get(ds) || 0;
    const a = audioMap.get(ds) || 0;
    const ig = ingestedMap.get(ds) || 0;
    result.push({ date: ds, screen: s, audio: a, total: s + a + ig });
  }
  return result;
}

export function getHourlyCountsForDate(date: string): { hour: number; count: number }[] {
  const rows = db.prepare(
    `SELECT cast(strftime('%H', timestamp, 'localtime') as integer) as h, count(*) as c FROM screen_states WHERE date(timestamp, 'localtime') = ? GROUP BY h`
  ).all(date) as { h: number; c: number }[];
  const audioRows = db.prepare(
    `SELECT cast(strftime('%H', timestamp, 'localtime') as integer) as h, count(*) as c FROM audio_transcripts WHERE date(timestamp, 'localtime') = ? GROUP BY h`
  ).all(date) as { h: number; c: number }[];
  const ingestedRows = db.prepare(
    `SELECT cast(strftime('%H', timestamp, 'localtime') as integer) as h, count(*) as c FROM ingested WHERE date(timestamp, 'localtime') = ? GROUP BY h`
  ).all(date) as { h: number; c: number }[];
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.h, (map.get(r.h) || 0) + r.c);
  for (const r of audioRows) map.set(r.h, (map.get(r.h) || 0) + r.c);
  for (const r of ingestedRows) map.set(r.h, (map.get(r.h) || 0) + r.c);
  return Array.from({ length: 24 }, (_, i) => ({ hour: i, count: map.get(i) || 0 }));
}

export function getCapturesForDate(date: string, limit: number = 200): Capture[] {
  const captures: Capture[] = [];
  const rows = db.prepare(
    `SELECT id, timestamp, app, window_title, texts, channel_names FROM screen_states WHERE date(timestamp, 'localtime') = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(date, limit) as any[];
  for (const r of rows) {
    const texts = JSON.parse(r.texts) as string[];
    const chans = r.channel_names ? JSON.parse(r.channel_names) : [];
    captures.push({ id: `s${r.id}`, timestamp: r.timestamp, type: "screen", app: r.app, title: r.window_title, excerpt: texts.join(" ").slice(0, 80), fullText: texts.join("\n"), channels: Array.isArray(chans) ? chans : [] });
  }
  const audioRows = db.prepare(
    `SELECT id, timestamp, transcript FROM audio_transcripts WHERE date(timestamp, 'localtime') = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(date, limit) as any[];
  for (const r of audioRows) {
    captures.push({ id: `a${r.id}`, timestamp: r.timestamp, type: "audio", app: "Audio", title: "whisper", excerpt: r.transcript.slice(0, 80), fullText: r.transcript, channels: [] });
  }
  const ingestedRows = db.prepare(
    `SELECT id, timestamp, source, channel_name, text FROM ingested WHERE date(timestamp, 'localtime') = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(date, limit) as any[];
  for (const r of ingestedRows) {
    captures.push({ id: `i${r.id}`, timestamp: r.timestamp, type: "ingested", app: `ingested:${r.source}`, title: r.source, excerpt: r.text.slice(0, 80), fullText: r.text, channels: r.channel_name ? [r.channel_name] : [] });
  }
  captures.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return captures.slice(0, limit);
}
