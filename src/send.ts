#!/usr/bin/env bun
/**
 * tunr send — capture current focused window and save to DB
 */
import { join, dirname } from "path";
import { Database } from "bun:sqlite";
import { DB_PATH, DATA_DIR } from "./lib/constants";
import { generateEmbedding } from "./lib/capture";

const AX_TEXT_PATH = join(dirname(process.execPath), "tunr-ax-text");
const AX_TEXT_FALLBACK = join(import.meta.dir, "..", "tunr-ax-text");
const axTextBin = await Bun.file(AX_TEXT_PATH).exists() ? AX_TEXT_PATH : AX_TEXT_FALLBACK;

// Get focused window info
const proc = Bun.spawnSync([axTextBin, "--all"], { stderr: "pipe" });
if (proc.exitCode !== 0) {
  console.error("Failed to get window text");
  process.exit(1);
}

const windows = JSON.parse(proc.stdout.toString().trim());
if (!windows || windows.length === 0) {
  console.error("No windows found");
  process.exit(1);
}

// Use first window (frontmost)
const w = windows[0];
if (!w.texts || w.texts.length === 0) {
  console.error("No text in focused window");
  process.exit(1);
}

// Write to DB
await Bun.write(join(DATA_DIR, ".keep"), "");
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode=WAL");

const ts = new Date().toISOString();
const textsJson = JSON.stringify(w.texts);
const embedding = generateEmbedding(w.texts.join("\n"));

db.prepare(
  `INSERT INTO screen_states (timestamp, pid, window_index, app, window_title, texts, embedding, screenshot_path, channel_names) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(ts, w.pid, w.window_index, w.app, w.title, textsJson, embedding, null, JSON.stringify(["__send__"]));

db.close();

const excerpt = w.texts.join(" ").slice(0, 80);
console.error(`Sent: ${w.app} · ${excerpt}`);
