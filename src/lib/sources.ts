import { db } from "./db";
import { AUDIO_SOURCE_KEY, MIC_SOURCE_KEY } from "./constants";

export interface SourceRow {
  window_key: string;
  app: string;
  title: string;
  urls: string[];
  channels: string[];
  last_seen: number;
  virtual: boolean;
}

const STALE_MS = 10_000;

export function upsertLiveSource(
  windowKey: string,
  app: string,
  title: string,
  urls: string[],
  now: number,
  virtual = false,
) {
  const existing = db.prepare(`SELECT channels FROM sources WHERE window_key = ?`).get(windowKey) as any;
  if (existing) {
    db.run(
      `UPDATE sources SET app = ?, title = ?, urls = ?, last_seen = ?, virtual = ? WHERE window_key = ?`,
      [app, title, JSON.stringify(urls), now, virtual ? 1 : 0, windowKey],
    );
  } else {
    db.run(
      `INSERT INTO sources (window_key, app, title, urls, channels, last_seen, virtual) VALUES (?, ?, ?, ?, '[]', ?, ?)`,
      [windowKey, app, title, JSON.stringify(urls), now, virtual ? 1 : 0],
    );
  }
}

export function pruneStaleSources(now: number) {
  db.run(`DELETE FROM sources WHERE virtual = 0 AND last_seen < ?`, [now - STALE_MS]);
}

export function listSources(): SourceRow[] {
  const rows = db.prepare(`SELECT window_key, app, title, urls, channels, last_seen, virtual FROM sources ORDER BY virtual DESC, app, title`).all() as any[];
  return rows.map(r => ({
    window_key: r.window_key,
    app: r.app,
    title: r.title,
    urls: safeJson(r.urls, []),
    channels: safeJson(r.channels, []),
    last_seen: r.last_seen,
    virtual: !!r.virtual,
  }));
}

export function getSourceChannels(windowKey: string): string[] {
  const r = db.prepare(`SELECT channels FROM sources WHERE window_key = ?`).get(windowKey) as any;
  if (!r) return [];
  return safeJson(r.channels, []);
}

export function setSourceChannels(windowKey: string, channels: string[]) {
  db.run(`UPDATE sources SET channels = ? WHERE window_key = ?`, [JSON.stringify(channels), windowKey]);
}

export function assignSource(windowKey: string, channel: string) {
  const cur = getSourceChannels(windowKey);
  if (cur.includes(channel)) return;
  setSourceChannels(windowKey, [...cur, channel]);
}

export function unassignSource(windowKey: string, channel: string) {
  const cur = getSourceChannels(windowKey);
  setSourceChannels(windowKey, cur.filter(c => c !== channel));
}

export function ensureVirtualSources(now: number) {
  upsertLiveSource(AUDIO_SOURCE_KEY, "Audio", "System Audio", [], now, true);
  upsertLiveSource(MIC_SOURCE_KEY, "Audio", "Microphone", [], now, true);
}

function safeJson<T>(s: string, fallback: T): T {
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
}
