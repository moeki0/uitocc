#!/usr/bin/env bun
/**
 * uitocc watch daemon — TUI for monitoring windows with per-window permissions
 */

import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { dirname } from "path";

// --- DB setup ---
const DATA_DIR = join(homedir(), "Library", "Application Support", "uitocc");
const DB_PATH = join(DATA_DIR, "uitocc.db");

await Bun.write(join(DATA_DIR, ".keep"), ""); // ensure dir exists

const db = new Database(DB_PATH);
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

// Add embedding column if missing
try { db.run(`ALTER TABLE screen_states ADD COLUMN embedding BLOB`); } catch {}

const insertStmt = db.prepare(
  `INSERT INTO screen_states (timestamp, pid, window_index, app, window_title, texts, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

// --- AX text helper ---
const AX_TEXT_PATH = join(dirname(process.execPath), "uitocc-ax-text");
const AX_TEXT_FALLBACK = join(import.meta.dir, "uitocc-ax-text");
const axTextBin = await Bun.file(AX_TEXT_PATH).exists() ? AX_TEXT_PATH : AX_TEXT_FALLBACK;

const EMBED_PATH = join(dirname(process.execPath), "uitocc-embed");
const EMBED_FALLBACK = join(import.meta.dir, "uitocc-embed");
const embedBin = await Bun.file(EMBED_PATH).exists() ? EMBED_PATH : EMBED_FALLBACK;

function generateEmbedding(text: string): Buffer | null {
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

interface WindowInfo {
  pid: number;
  window_index: number;
  app: string;
  title: string;
  texts: string[];
}

async function getAllWindows(): Promise<WindowInfo[]> {
  try {
    const proc = Bun.spawnSync([axTextBin, "--all"], { stderr: "pipe" });
    if (proc.exitCode !== 0) return [];
    const out = proc.stdout.toString().trim();
    if (!out) return [];
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function windowKey(w: { pid: number; window_index: number }): string {
  return `${w.pid}:${w.window_index}`;
}

// --- Types ---
type Permission = "allowed" | "denied" | "pending";

interface TrackedWindow {
  pid: number;
  window_index: number;
  app: string;
  title: string;
  permission: Permission;
  lastSeen: number;
}

// --- Polling interval ---
const POLL_MS = 3000;
const RECORD_MS = 5000;

// --- React TUI ---
function App() {
  const { exit } = useApp();
  const [windows, setWindows] = useState<Map<string, TrackedWindow>>(new Map());
  const windowsRef = useRef<Map<string, TrackedWindow>>(new Map());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [recordCount, setRecordCount] = useState(0);

  // Keep ref in sync with state
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);

  // Poll for windows
  useEffect(() => {
    let active = true;
    async function poll() {
      while (active) {
        const found = await getAllWindows();
        const now = Date.now();

        setWindows((prev) => {
          const next = new Map(prev);
          const seenKeys = new Set<string>();

          for (const w of found) {
            const key = windowKey(w);
            seenKeys.add(key);
            const existing = next.get(key);
            if (existing) {
              // Update title and lastSeen
              next.set(key, { ...existing, title: w.title, lastSeen: now });
            } else {
              // New window
              next.set(key, {
                pid: w.pid,
                window_index: w.window_index,
                app: w.app,
                title: w.title,
                permission: "pending",
                lastSeen: now,
              });
            }
          }

          // Remove windows not seen for >10s
          for (const [key, tw] of next) {
            if (!seenKeys.has(key) && now - tw.lastSeen > 10000) {
              next.delete(key);
            }
          }

          return next;
        });

        await Bun.sleep(POLL_MS);
      }
    }
    poll();
    return () => { active = false; };
  }, []);

  // Set pending key to the first pending window
  useEffect(() => {
    if (pendingKey && windows.get(pendingKey)?.permission === "pending") return;
    for (const [key, w] of windows) {
      if (w.permission === "pending") {
        setPendingKey(key);
        return;
      }
    }
    setPendingKey(null);
  }, [windows, pendingKey]);

  // Record allowed windows periodically
  useEffect(() => {
    let active = true;
    async function record() {
      while (active) {
        await Bun.sleep(RECORD_MS);
        const allowedWindows: TrackedWindow[] = [];
        for (const [, w] of windowsRef.current) {
          if (w.permission === "allowed") allowedWindows.push(w);
        }

        if (allowedWindows.length === 0) continue;

        const found = await getAllWindows();
        const foundMap = new Map(found.map((w) => [windowKey(w), w]));
        const ts = new Date().toISOString();

        for (const tw of allowedWindows) {
          const key = windowKey(tw);
          const w = foundMap.get(key);
          if (!w) continue;
          const textForEmbed = `${w.app} ${w.title} ${w.texts.slice(0, 10).join(" ")}`.slice(0, 1000);
          const emb = generateEmbedding(textForEmbed);
          insertStmt.run(ts, w.pid, w.window_index, w.app, w.title, JSON.stringify(w.texts), emb);
          setRecordCount((c) => c + 1);
        }
      }
    }
    record();
    return () => { active = false; };
  }, []);

  // Handle input
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      db.close();
      exit();
      return;
    }

    if (!pendingKey) return;

    if (input === "y" || input === "Y") {
      setWindows((prev) => {
        const next = new Map(prev);
        const w = next.get(pendingKey);
        if (w) next.set(pendingKey, { ...w, permission: "allowed" });
        return next;
      });
    } else if (input === "n" || input === "N") {
      setWindows((prev) => {
        const next = new Map(prev);
        const w = next.get(pendingKey);
        if (w) next.set(pendingKey, { ...w, permission: "denied" });
        return next;
      });
    }
  });

  const allowed = [...windows.values()].filter((w) => w.permission === "allowed");
  const denied = [...windows.values()].filter((w) => w.permission === "denied");
  const pending = [...windows.values()].filter((w) => w.permission === "pending");
  const pendingWindow = pendingKey ? windows.get(pendingKey) : null;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          uitocc watch
        </Text>
        <Text color="gray">
          {" "}
          — {allowed.length} watching, {denied.length} denied, {recordCount} recorded
        </Text>
      </Box>

      {allowed.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {allowed.map((w) => (
            <Box key={windowKey(w)}>
              <Text color="green"> ✓ </Text>
              <Text bold>{w.app}</Text>
              <Text color="gray"> — {w.title || "(untitled)"}</Text>
            </Box>
          ))}
        </Box>
      )}

      {denied.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {denied.map((w) => (
            <Box key={windowKey(w)}>
              <Text color="red"> ✗ </Text>
              <Text dimColor>{w.app}</Text>
              <Text color="gray" dimColor>
                {" "}
                — {w.title || "(untitled)"}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {pendingWindow ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>
            ⚡ New window detected
          </Text>
          <Box marginTop={0}>
            <Text>
              {"  "}
              <Text bold>{pendingWindow.app}</Text>
              <Text color="gray"> — {pendingWindow.title || "(untitled)"}</Text>
            </Text>
          </Box>
          <Box marginTop={0}>
            <Text>
              {"  "}Allow? <Text color="green" bold>(y)</Text>es / <Text color="red" bold>(n)</Text>o
            </Text>
          </Box>
        </Box>
      ) : pending.length === 0 ? (
        <Box>
          <Text color="gray" dimColor>
            Watching for new windows... (q to quit)
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

render(React.createElement(App));
