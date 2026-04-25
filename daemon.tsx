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
import { unlinkSync } from "fs";

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

// Add columns if missing
try { db.run(`ALTER TABLE screen_states ADD COLUMN embedding BLOB`); } catch {}
try { db.run(`ALTER TABLE screen_states ADD COLUMN screenshot_path TEXT`); } catch {}

const SCREENSHOTS_DIR = join(DATA_DIR, "screenshots");
await Bun.write(join(SCREENSHOTS_DIR, ".keep"), "");

const AUDIO_DIR = join(DATA_DIR, "audio");
await Bun.write(join(AUDIO_DIR, ".keep"), "");

db.run(`CREATE TABLE IF NOT EXISTS audio_transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  audio_path TEXT NOT NULL,
  transcript TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_audio_timestamp ON audio_transcripts(timestamp)`);

const insertAudioStmt = db.prepare(
  `INSERT INTO audio_transcripts (timestamp, audio_path, transcript) VALUES (?, ?, ?)`
);

const insertStmt = db.prepare(
  `INSERT INTO screen_states (timestamp, pid, window_index, app, window_title, texts, embedding, screenshot_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
  window_id: number;
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

  // Record allowed windows periodically (with dedup)
  useEffect(() => {
    let active = true;
    const lastRecorded = new Map<string, string>(); // windowKey -> title + texts hash
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
          const uniqueTexts = [...new Set(w.texts)];
          const textsJson = JSON.stringify(uniqueTexts);
          const fingerprint = `${w.title}\0${textsJson}`;
          if (lastRecorded.get(key) === fingerprint) continue;
          lastRecorded.set(key, fingerprint);
          // Capture screenshot
          let screenshotPath: string | null = null;
          if (w.window_id) {
            const filename = `${ts.replace(/[:.]/g, "-")}_${w.pid}_${w.window_index}.png`;
            const filepath = join(SCREENSHOTS_DIR, filename);
            const sc = Bun.spawnSync(["/usr/sbin/screencapture", `-l${w.window_id}`, "-x", filepath]);
            if (sc.exitCode === 0) screenshotPath = filepath;
          }
          const textForEmbed = `${w.app} ${w.title} ${w.texts.slice(0, 10).join(" ")}`.slice(0, 1000);
          const emb = generateEmbedding(textForEmbed);
          insertStmt.run(ts, w.pid, w.window_index, w.app, w.title, textsJson, emb, screenshotPath);
          setRecordCount((c) => c + 1);
        }
      }
    }
    // Cleanup old screenshots (>24h) every 10 minutes
    async function cleanup() {
      while (active) {
        await Bun.sleep(600_000);
        const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
        const old = db.prepare(
          `SELECT id, screenshot_path FROM screen_states WHERE timestamp < ? AND screenshot_path IS NOT NULL`
        ).all(cutoff) as any[];
        for (const row of old) {
          try { unlinkSync(row.screenshot_path); } catch {}
        }
        db.run(`UPDATE screen_states SET screenshot_path = NULL WHERE timestamp < ? AND screenshot_path IS NOT NULL`, cutoff);
      }
    }
    record();
    cleanup();
    return () => { active = false; };
  }, []);

  // Audio capture & transcription
  const [audioEnabled, setAudioEnabled] = useState(true);
  const audioEnabledRef = useRef(true);
  const [audioStatus, setAudioStatus] = useState<string>("starting");
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const audioProcRef = useRef<any>(null);

  useEffect(() => {
    audioEnabledRef.current = audioEnabled;
  }, [audioEnabled]);

  useEffect(() => {
    let active = true;
    const AUDIO_CAPTURE_PATH = join(dirname(process.execPath), "uitocc-audio-capture");
    const AUDIO_CAPTURE_FALLBACK = join(import.meta.dir, "uitocc-audio-capture");

    async function startAudio() {
      const audioBin = await Bun.file(AUDIO_CAPTURE_PATH).exists() ? AUDIO_CAPTURE_PATH : AUDIO_CAPTURE_FALLBACK;
      if (!await Bun.file(audioBin).exists()) {
        setAudioStatus("no binary");
        return;
      }

      while (active) {
        if (!audioEnabledRef.current) {
          setAudioStatus("off");
          await Bun.sleep(1000);
          continue;
        }

        setAudioStatus("recording");
        const proc = Bun.spawn([audioBin, AUDIO_DIR, "30"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        audioProcRef.current = proc;

        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (active && audioEnabledRef.current) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              const modelPath = join(homedir(), ".cache", "whisper-cpp-small.bin");
              const wp = Bun.spawnSync([
                "whisper-cli",
                "-m", modelPath,
                "-l", "ja",
                "-f", chunk.file,
                "-np",
                "-nt",
              ], { stdout: "pipe", stderr: "pipe" });
              const transcript = wp.stdout.toString().trim();
              if (transcript) {
                insertAudioStmt.run(chunk.timestamp, chunk.file, transcript);
                setLastTranscript(transcript.slice(0, 80));
              }
            } catch {}
          }
        }

        proc.kill();
        audioProcRef.current = null;
      }
    }

    startAudio();

    // Cleanup old audio (>24h)
    async function cleanupAudio() {
      while (active) {
        await Bun.sleep(600_000);
        const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
        const old = db.prepare(
          `SELECT id, audio_path FROM audio_transcripts WHERE timestamp < ?`
        ).all(cutoff) as any[];
        for (const row of old) {
          try { unlinkSync(row.audio_path); } catch {}
        }
        db.run(`DELETE FROM audio_transcripts WHERE timestamp < ?`, cutoff);
      }
    }
    cleanupAudio();

    return () => { active = false; };
  }, []);

  // Selected window index for re-configuring
  const [selectedIndex, setSelectedIndex] = useState(-1);

  // Handle input
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      if (audioProcRef.current) audioProcRef.current.kill();
      db.close();
      exit();
      return;
    }

    // Toggle audio
    if (input === "a" || input === "A") {
      setAudioEnabled((prev) => !prev);
      return;
    }

    // Pending window prompt
    if (pendingKey) {
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
      return;
    }

    // Navigate window list
    const allWindows = [...windows.values()].filter((w) => w.permission !== "pending");
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(allWindows.length - 1, prev + 1));
    } else if (input === "t" || input === "T") {
      // Toggle permission of selected window
      if (selectedIndex >= 0 && selectedIndex < allWindows.length) {
        const target = allWindows[selectedIndex];
        const key = windowKey(target);
        setWindows((prev) => {
          const next = new Map(prev);
          const w = next.get(key);
          if (w) {
            const newPerm = w.permission === "allowed" ? "denied" : "allowed";
            next.set(key, { ...w, permission: newPerm });
          }
          return next;
        });
      }
    }
  });

  const allowed = [...windows.values()].filter((w) => w.permission === "allowed");
  const denied = [...windows.values()].filter((w) => w.permission === "denied");
  const configured = [...windows.values()].filter((w) => w.permission !== "pending");
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
          — {allowed.length} watching, {recordCount} recorded
        </Text>
        <Text color={audioEnabled ? "green" : "gray"}>
          {" "}| audio: {audioEnabled ? audioStatus : "off"}
        </Text>
      </Box>

      {configured.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {configured.map((w, i) => {
            const isSelected = !pendingKey && i === selectedIndex;
            const isAllowed = w.permission === "allowed";
            return (
              <Box key={windowKey(w)}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {isSelected ? "▸" : " "}
                </Text>
                <Text color={isAllowed ? "green" : "red"}>
                  {isAllowed ? " ✓ " : " ✗ "}
                </Text>
                <Text bold={isAllowed} dimColor={!isAllowed}>{w.app}</Text>
                <Text color="gray" dimColor={!isAllowed}>
                  {" "}— {w.title || "(untitled)"}
                </Text>
              </Box>
            );
          })}
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
      ) : null}

      {lastTranscript && audioEnabled && (
        <Box marginTop={1}>
          <Text color="gray">🎙 {lastTranscript}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ select  t toggle  a audio {audioEnabled ? "off" : "on"}  q quit
        </Text>
      </Box>
    </Box>
  );
}

render(React.createElement(App));
