#!/usr/bin/env bun
/**
 * uitocc daemon — Screen observer using macOS Accessibility API
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

// --- Config ---

const DATA_DIR = join(homedir(), "Library", "Application Support", "uitocc");
const DB_PATH = join(DATA_DIR, "context.db");
const SCREENSHOT_DIR = join(DATA_DIR, "screenshots");
const CHECK_INTERVAL = 2000; // 2 seconds
const CONTENT_CHANGE_COOLDOWN = 10_000; // 10 seconds

// Ensure directories exist
for (const dir of [DATA_DIR, SCREENSHOT_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- Database ---

function initDB(): Database {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      app TEXT NOT NULL,
      window_title TEXT NOT NULL,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS screen_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      app TEXT NOT NULL,
      window_title TEXT NOT NULL,
      visible_texts TEXT NOT NULL,
      other_apps TEXT,
      screenshot_path TEXT
    );
  `);
  return db;
}

const db = initDB();
const insertAction = db.prepare(
  "INSERT INTO actions (timestamp, type, app, window_title, description) VALUES (?, ?, ?, ?, ?)"
);
const insertScreenState = db.prepare(
  "INSERT INTO screen_states (timestamp, app, window_title, visible_texts, other_apps, screenshot_path) VALUES (?, ?, ?, ?, ?, ?)"
);

// --- Screen State ---

interface ScreenState {
  app: string;
  windowTitle: string;
  texts: string[];
}

function getScreenState(): ScreenState | null {
  const axTextPath = join(dirname(process.execPath), "uitocc-ax-text");
  const result = Bun.spawnSync([axTextPath]);
  if (result.exitCode !== 0) return null;

  const lines = new TextDecoder().decode(result.stdout).trim().split("\n");
  let app = "";
  let windowTitle = "";
  const texts: string[] = [];

  for (const line of lines) {
    if (line.startsWith("app:")) app = line.slice(4);
    else if (line.startsWith("window:")) windowTitle = line.slice(7);
    else if (line.startsWith("text:")) texts.push(line.slice(5));
  }

  return app ? { app, windowTitle, texts } : null;
}

// --- Action Detection ---

function normalizeTitle(title: string): string {
  return title
    .replace(/^[\s✳·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠂⠈⣿⡿⣷⣯⣟⡾⢷⣾⣽⣻⢿◐◑◒◓●○◉⦿★☆\-–—*•\u2800-\u28FF]+/, "")
    .trim();
}

function textOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  return intersection.size / Math.max(setA.size, setB.size);
}

const seenWindows = new Set<string>();
let lastContentChangeTime = 0;

interface DetectedAction {
  type: "app_switch" | "navigation" | "content_change";
  app: string;
  windowTitle: string;
  description: string;
}

function detectActions(prev: ScreenState | null, current: ScreenState): DetectedAction[] {
  const actions: DetectedAction[] = [];

  if (!prev || prev.app !== current.app) {
    const key = `${current.app}\0${normalizeTitle(current.windowTitle)}`;
    if (!seenWindows.has(key)) {
      seenWindows.add(key);
      actions.push({
        type: "app_switch",
        app: current.app,
        windowTitle: current.windowTitle,
        description: `${prev?.app || "(none)"} → ${current.app}`,
      });
    }
    return actions;
  }

  if (prev && normalizeTitle(prev.windowTitle) !== normalizeTitle(current.windowTitle)) {
    const key = `${current.app}\0${normalizeTitle(current.windowTitle)}`;
    if (!seenWindows.has(key)) {
      seenWindows.add(key);
      actions.push({
        type: "navigation",
        app: current.app,
        windowTitle: current.windowTitle,
        description: current.windowTitle,
      });
    }
    return actions;
  }

  const now = Date.now();
  if (now - lastContentChangeTime >= CONTENT_CHANGE_COOLDOWN) {
    const overlap = textOverlap(prev?.texts ?? [], current.texts);
    if (overlap < 0.7 && current.texts.length > 0) {
      lastContentChangeTime = now;
      actions.push({
        type: "content_change",
        app: current.app,
        windowTitle: current.windowTitle,
        description: current.windowTitle,
      });
    }
  }

  return actions;
}

// --- Main Loop ---

let prevState: ScreenState | null = null;

async function main() {
  while (true) {
    await Bun.sleep(CHECK_INTERVAL);

    const currentState = getScreenState();
    if (!currentState) {
      prevState = null;
      continue;
    }

    const actions = detectActions(prevState, currentState);
    prevState = currentState;

    if (actions.length === 0) continue;

    const ts = new Date().toISOString();

    for (const action of actions) {
      console.log(`[${ts}] ${action.type}: ${action.app} — "${action.windowTitle}"`);
      insertAction.run(ts, action.type, action.app, action.windowTitle, action.description);
    }

    const textsJSON = JSON.stringify(currentState.texts.slice(0, 100));
    insertScreenState.run(
      ts,
      currentState.app,
      currentState.windowTitle,
      textsJSON,
      null,
      null
    );
  }
}

process.on("SIGINT", () => {
  console.log("\nuitocc daemon stopped");
  db.close();
  process.exit(0);
});

main();
