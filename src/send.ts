#!/usr/bin/env bun
/**
 * tunr send — capture current focused window and save to DB
 */
import { join, dirname } from "path";
import { Database } from "bun:sqlite";
import { DB_PATH, DATA_DIR, SCREENSHOT_DIR } from "./lib/constants";
import { generateEmbedding } from "./lib/capture";

const AX_TEXT_PATH = join(dirname(process.execPath), "tunr-ax-text");
const AX_TEXT_FALLBACK = join(import.meta.dir, "..", "tunr-ax-text");
const axTextBin = await Bun.file(AX_TEXT_PATH).exists() ? AX_TEXT_PATH : AX_TEXT_FALLBACK;

// Get frontmost app PID
const frontProc = Bun.spawnSync(["osascript", "-e", 'tell application "System Events" to unix id of first process whose frontmost is true'], { stdout: "pipe", stderr: "pipe" });
const frontPid = parseInt(frontProc.stdout.toString().trim());

// Get all windows
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

// Find frontmost app's first window
const w = windows.find((w: any) => w.pid === frontPid) || windows[0];
if (!w.texts || w.texts.length === 0) {
  console.error("No text in focused window");
  process.exit(1);
}

const wantImage = process.argv.includes("--image") || process.argv.includes("-i");

// Write to DB
await Bun.write(join(DATA_DIR, ".keep"), "");
await Bun.write(join(SCREENSHOT_DIR, ".keep"), "");
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode=WAL");

const ts = new Date().toISOString();
const textsJson = JSON.stringify(w.texts);
const embedding = generateEmbedding(w.texts.join("\n"));

let screenshotPath: string | null = null;
if (wantImage && w.window_id) {
  const safeTs = ts.replace(/[:.]/g, "-");
  const out = join(SCREENSHOT_DIR, `${safeTs}.png`);
  const cap = Bun.spawnSync(
    ["screencapture", "-x", "-l", String(w.window_id), out],
    { stderr: "pipe" }
  );
  if (cap.exitCode === 0 && await Bun.file(out).exists()) {
    screenshotPath = out;
  } else {
    console.error("Screenshot failed; saving record without image");
  }
}

db.prepare(
  `INSERT INTO screen_states (timestamp, pid, window_index, app, window_title, texts, embedding, channel_names, window_id, screenshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(ts, w.pid, w.window_index, w.app, w.title, textsJson, embedding, JSON.stringify(["__send__"]), w.window_id ?? 0, screenshotPath);

db.close();

console.error(`Sent: ${w.app} · [${w.texts.length} text(s)]${screenshotPath ? ` · screenshot: ${screenshotPath}` : ""}`);
