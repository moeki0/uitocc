#!/usr/bin/env bun
/**
 * uitocc watch daemon — TUI for monitoring windows with per-window permissions
 */

import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { dirname } from "path";
import { unlinkSync } from "fs";

// --- DB setup ---
const DATA_DIR = join(homedir(), "Library", "Application Support", "uitocc");
const DB_PATH = join(DATA_DIR, "uitocc.db");

await Bun.write(join(DATA_DIR, ".keep"), ""); // ensure dir exists

// --- Settings ---
const SETTINGS_PATH = join(DATA_DIR, "settings.json");
let _savedSettings: any = {};
try {
  if (await Bun.file(SETTINGS_PATH).exists()) {
    _savedSettings = JSON.parse(await Bun.file(SETTINGS_PATH).text());
  }
} catch {}
const savedAudioChunkSec = typeof _savedSettings.audioChunkSec === "number" ? _savedSettings.audioChunkSec : 10;

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

// --- React TUI ---
function App() {
  const { exit } = useApp();
  const [windows, setWindows] = useState<Map<string, TrackedWindow>>(new Map());
  const windowsRef = useRef<Map<string, TrackedWindow>>(new Map());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [recordCount, setRecordCount] = useState(0);
  const [screenSize, setScreenSize] = useState("0 MB");
  const [audioSize, setAudioSize] = useState("0 MB");
  const [screenIntervalSec, setScreenIntervalSec] = useState(typeof _savedSettings.screenIntervalSec === "number" ? _savedSettings.screenIntervalSec : 5);
  const screenIntervalRef = useRef(typeof _savedSettings.screenIntervalSec === "number" ? _savedSettings.screenIntervalSec : 5);
  const [tvBroadcastCount, setTvBroadcastCount] = useState(0);

  // Update storage sizes every 10s
  useEffect(() => {
    function updateSizes() {
      try {
        const dbStat = Bun.spawnSync(["du", "-sh", SCREENSHOTS_DIR], { stdout: "pipe" });
        const dbOut = dbStat.stdout.toString().trim().split("\t")[0] || "0";
        setScreenSize(dbOut);
      } catch {}
      try {
        const audioStat = Bun.spawnSync(["du", "-sh", AUDIO_DIR], { stdout: "pipe" });
        const audioOut = audioStat.stdout.toString().trim().split("\t")[0] || "0";
        setAudioSize(audioOut);
      } catch {}
    }
    updateSizes();
    const iv = setInterval(updateSizes, 10000);
    return () => clearInterval(iv);
  }, []);

  // History logs
  const [audioLog, setAudioLog] = useState<string[]>([]);
  const addAudioLog = (entry: string) => setAudioLog((prev) => [entry, ...prev].slice(0, 5));
  const [radioBroadcastCount, setRadioBroadcastCount] = useState(0);

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

  // Record allowed windows periodically (with dedup) + event-driven capture
  useEffect(() => {
    let active = true;
    const lastRecorded = new Map<string, string>(); // windowKey -> title + texts hash
    const lastScreenshot = new Map<string, string>(); // windowKey -> last screenshot path
    const IMAGE_DIFF_PATH = join(dirname(process.execPath), "uitocc-image-diff");
    const IMAGE_DIFF_FALLBACK = join(import.meta.dir, "uitocc-image-diff");
    const EVENT_MONITOR_PATH = join(dirname(process.execPath), "uitocc-event-monitor");
    const EVENT_MONITOR_FALLBACK = join(import.meta.dir, "uitocc-event-monitor");
    const DIFF_THRESHOLD = 0.01;
    let pendingEventCapture = false;

    // Start event monitor (scroll + key detection)
    async function startEventMonitor() {
      const monBin = await Bun.file(EVENT_MONITOR_PATH).exists() ? EVENT_MONITOR_PATH : EVENT_MONITOR_FALLBACK;
      if (!await Bun.file(monBin).exists()) return;
      const proc = Bun.spawn([monBin], { stdout: "pipe", stderr: "pipe" });
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (active) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) pendingEventCapture = true;
        }
      }
    }
    startEventMonitor();

    async function record() {
      const imageDiffBin = await Bun.file(IMAGE_DIFF_PATH).exists() ? IMAGE_DIFF_PATH : IMAGE_DIFF_FALLBACK;
      const hasImageDiff = await Bun.file(imageDiffBin).exists();
      while (active) {
        // Wait for timer or event trigger
        if (!pendingEventCapture) {
          await Bun.sleep(screenIntervalRef.current * 1000);
        }
        pendingEventCapture = false;

        const allowedWindows: TrackedWindow[] = [];
        for (const [, w] of windowsRef.current) {
          if (w.permission === "allowed") allowedWindows.push(w);
        }

        if (allowedWindows.length === 0) continue;

        const found = await getAllWindows();
        const foundMap = new Map(found.map((w) => [windowKey(w), w]));
        const ts = new Date().toISOString();
        const time = ts.slice(11, 19);
        const changedScreenshots: { app: string; title: string; path: string }[] = [];

        for (const tw of allowedWindows) {
          const key = windowKey(tw);
          const w = foundMap.get(key);
          if (!w) continue;
          const uniqueTexts = [...new Set(w.texts)];
          const textsJson = JSON.stringify(uniqueTexts);
          const normalizedTitle = w.title.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠂⠄⠠⠈⠁✳⣾⣽⣻⢿⡿⣟⣯⣷⠀]/g, "").trim();
          const fingerprint = `${normalizedTitle}\0${textsJson}`;
          const textChanged = lastRecorded.get(key) !== fingerprint;

          // Always capture screenshot for pixel diff
          let screenshotPath: string | null = null;
          let visuallyChanged = false;
          if (w.window_id) {
            const filename = `${ts.replace(/[:.]/g, "-")}_${w.pid}_${w.window_index}.png`;
            const filepath = join(SCREENSHOTS_DIR, filename);
            const sc = Bun.spawnSync(["/usr/sbin/screencapture", `-l${w.window_id}`, "-x", filepath]);
            if (sc.exitCode === 0) {
              const prevPath = lastScreenshot.get(key);
              if (!prevPath || !hasImageDiff) {
                visuallyChanged = true;
              } else {
                const diff = Bun.spawnSync([imageDiffBin, prevPath, filepath], { stdout: "pipe" });
                const ratio = parseFloat(diff.stdout.toString().trim());
                visuallyChanged = isNaN(ratio) || ratio > DIFF_THRESHOLD;
              }

              if (textChanged || visuallyChanged) {
                screenshotPath = filepath;
                lastScreenshot.set(key, filepath);
                changedScreenshots.push({ app: w.app, title: w.title, path: filepath });
              } else {
                try { unlinkSync(filepath); } catch {}
              }
            }
          }

          if (!textChanged && !visuallyChanged) continue;
          lastRecorded.set(key, fingerprint);

          const textForEmbed = `${w.app} ${w.title} ${w.texts.slice(0, 10).join(" ")}`.slice(0, 1000);
          const emb = generateEmbedding(textForEmbed);
          insertStmt.run(ts, w.pid, w.window_index, w.app, w.title, textsJson, emb, screenshotPath);
          setRecordCount((c) => c + 1);
        }

        // Broadcast all changed screenshots as a single TV event
        if (tvChannelRef.current && changedScreenshots.length > 0) {
          const tvEventPath = join(DATA_DIR, "channel_tv_event.json");
          await Bun.write(tvEventPath, JSON.stringify({
            timestamp: ts,
            screenshots: changedScreenshots.map((s) => ({
              app: s.app,
              windowTitle: s.title,
              screenshotPath: s.path,
            })),
          }));
          const names = changedScreenshots.map((s) => s.app).join(", ");
          setTvBroadcastCount((c) => c + 1);
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

  // Channel status (TV = screen, RADIO = audio)
  const [tvChannelActive, setTvChannelActive] = useState(false);
  const [radioChannelActive, setRadioChannelActive] = useState(false);
  const tvChannelRef = useRef(false);
  const radioChannelRef = useRef(false);
  useEffect(() => { tvChannelRef.current = tvChannelActive; }, [tvChannelActive]);
  useEffect(() => { radioChannelRef.current = radioChannelActive; }, [radioChannelActive]);
  useEffect(() => {
    const statusPath = join(DATA_DIR, "channel_status.json");
    const tid = setInterval(async () => {
      try {
        const f = Bun.file(statusPath);
        if (await f.exists()) {
          const data = JSON.parse(await f.text());
          if (data.tv !== undefined) setTvChannelActive(!!data.tv);
          if (data.radio !== undefined) setRadioChannelActive(!!data.radio);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(tid);
  }, []);

  // Audio capture & transcription
  const [audioEnabled, setAudioEnabled] = useState(true);
  const audioEnabledRef = useRef(true);
  const [audioStatus, setAudioStatus] = useState<string>("starting");
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [audioChunkSec, setAudioChunkSec] = useState(savedAudioChunkSec);
  const audioChunkRef = useRef(savedAudioChunkSec);
  const audioProcRef = useRef<any>(null);

  useEffect(() => {
    audioEnabledRef.current = audioEnabled;
  }, [audioEnabled]);
  useEffect(() => {
    audioChunkRef.current = audioChunkSec;
    Bun.write(SETTINGS_PATH, JSON.stringify({ audioChunkSec, screenIntervalSec }));
  }, [audioChunkSec]);
  useEffect(() => {
    screenIntervalRef.current = screenIntervalSec;
    Bun.write(SETTINGS_PATH, JSON.stringify({ audioChunkSec, screenIntervalSec }));
  }, [screenIntervalSec]);

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

      // Check whisper-cli and model
      const whisperCheck = Bun.spawnSync(["which", "whisper-cli"], { stdout: "pipe", stderr: "pipe" });
      if (whisperCheck.exitCode !== 0) {
        setAudioStatus("disabled — whisper-cpp not installed (brew install whisper-cpp)");
        setAudioEnabled(false);
        return;
      }
      const modelPath = join(homedir(), ".cache", "whisper-cpp-small.bin");
      if (!await Bun.file(modelPath).exists()) {
        setAudioStatus("disabled — whisper model not found (~/.cache/whisper-cpp-small.bin)");
        setAudioEnabled(false);
        return;
      }

      while (active) {
        if (!audioEnabledRef.current) {
          setAudioStatus("off");
          await Bun.sleep(1000);
          continue;
        }

        setAudioStatus("recording");
        const proc = Bun.spawn([audioBin, AUDIO_DIR, String(audioChunkRef.current)], {
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
                const time = chunk.timestamp.slice(11, 19);
                addAudioLog(`${time} ${transcript.slice(0, 40)}`);
                // Write channel event for MCP server (only when RADIO is active)
                if (radioChannelRef.current) {
                  const audioEventPath = join(DATA_DIR, "channel_audio_event.json");
                  await Bun.write(audioEventPath, JSON.stringify({
                    timestamp: chunk.timestamp,
                    transcript,
                  }));
                  setRadioBroadcastCount((c) => c + 1);
                }
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
      process.exit(0);
    }

    // Toggle audio
    if (input === "a" || input === "A") {
      setAudioEnabled((prev) => !prev);
      return;
    }

    // Toggle TV channel
    if (input === "1") {
      setTvChannelActive((prev: boolean) => {
        const next = !prev;
        Bun.write(join(DATA_DIR, "channel_status.json"), JSON.stringify({ tv: next, radio: radioChannelActive }));
        return next;
      });
      return;
    }

    // Toggle RADIO channel
    if (input === "2") {
      setRadioChannelActive((prev: boolean) => {
        const next = !prev;
        Bun.write(join(DATA_DIR, "channel_status.json"), JSON.stringify({ tv: tvChannelActive, radio: next }));
        return next;
      });
      return;
    }

    // Screen capture interval
    if (input === "[") {
      setScreenIntervalSec((prev: number) => Math.max(3, prev - 1));
      return;
    }
    if (input === "]") {
      setScreenIntervalSec((prev: number) => Math.min(30, prev + 1));
      return;
    }

    // Delete all recorded data
    if (input === "d" || input === "D") {
      db.run("DELETE FROM screen_states");
      db.run("DELETE FROM audio_transcripts");
      // Clear screenshot files
      try {
        const files = Bun.spawnSync(["find", SCREENSHOTS_DIR, "-name", "*.png", "-delete"], { stdout: "pipe", stderr: "pipe" });
      } catch {}
      // Clear audio files
      try {
        Bun.spawnSync(["find", AUDIO_DIR, "-name", "*.wav", "-delete"], { stdout: "pipe", stderr: "pipe" });
      } catch {}
      setRecordCount(0);
      setAudioCount(0);
      setTvBroadcastCount(0);
      setRadioBroadcastCount(0);
      setScreenSize("0B");
      setAudioSize("0B");
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

  // Terminal size
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  // Clock
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const clock = now.toLocaleTimeString("ja-JP", { hour12: false });
  const dateStr = now.toLocaleDateString("ja-JP");

  const allowed = [...windows.values()].filter((w) => w.permission === "allowed");
  const configured = [...windows.values()].filter((w) => w.permission !== "pending");
  const pendingWindow = pendingKey ? windows.get(pendingKey) : null;

  const recBlink = now.getSeconds() % 2 === 0;

  return (
    <Box flexDirection="column" paddingX={1} height={rows}>
      {/* Header */}
      <Box borderStyle="single" borderColor="green" paddingX={1} justifyContent="space-between">
        <Text color="green" bold> UITOCC CONTROL ROOM </Text>
        <Text color="green">
          {dateStr} {clock}
        </Text>
      </Box>

      {/* Main panels */}
      <Box flexDirection="column" marginTop={0} flexGrow={1}>

        {/* ═══ RECORDING ═══ */}
        <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1}>
          <Text color="green" bold> RECORDING </Text>

          {/* SCREEN */}
          <Box flexDirection="column" borderStyle="single" borderColor="green" marginTop={0} paddingX={1}>
            <Box gap={2}>
              <Text color="green" bold> SCREEN </Text>
              <Text color={allowed.length > 0 ? "green" : "yellow"}>
                FEEDS: {allowed.length}/{configured.length}
              </Text>
              <Text color="green">
                {recBlink ? "●" : "○"} REC {recordCount}  [{screenSize}]  [{screenIntervalSec}s]
              </Text>
            </Box>
            {configured.length > 0 ? (
              <Box flexDirection="column">
                {configured.map((w, i) => {
                  const isSelected = !pendingKey && i === selectedIndex;
                  const isAllowed = w.permission === "allowed";
                  const camId = String(i + 1).padStart(2, "0");
                  return (
                    <Box key={windowKey(w)}>
                      <Text color={isSelected ? "cyan" : "green"}>
                        {isSelected ? "▸ " : "  "}
                      </Text>
                      <Text color={isAllowed ? "green" : "red"}>
                        CAM-{camId}
                      </Text>
                      <Text color={isAllowed ? "green" : "red"}>
                        {isAllowed ? " [LIVE]  " : " [----]  "}
                      </Text>
                      <Text color={isAllowed ? "white" : "gray"}>
                        {w.app}
                      </Text>
                      <Text color="gray">
                        {" "}| {(w.title || "untitled").slice(0, 40)}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            ) : (
              <Text color="yellow"> NO FEEDS DETECTED </Text>
            )}
            {/* Alert panel */}
            {pendingWindow ? (
              <Box flexDirection="column" marginTop={0}>
                <Text color="yellow" bold> ⚠ UNIDENTIFIED FEED </Text>
                <Text color="white">
                  {"  "}{pendingWindow.app}
                  <Text color="gray"> | {pendingWindow.title || "untitled"}</Text>
                </Text>
                <Text>
                  {"  "}AUTHORIZE? <Text color="green" bold>[Y]</Text> GRANT  <Text color="red" bold>[N]</Text> DENY
                </Text>
              </Box>
            ) : null}
          </Box>

          {/* AUDIO */}
          <Box flexDirection="column" borderStyle="single" borderColor={audioEnabled ? "green" : "gray"} marginTop={0} paddingX={1}>
            <Box gap={2}>
              <Text color={audioEnabled ? "green" : "gray"} bold> AUDIO </Text>
              <Text color={audioEnabled ? (audioStatus === "recording" ? "green" : "yellow") : "red"}>
                {audioEnabled && audioStatus === "recording" ? (recBlink ? "●" : "○") : "○"} MIC {audioEnabled ? audioStatus.toUpperCase() : "OFF"}  [{audioSize}]
              </Text>
            </Box>
            {audioEnabled && lastTranscript ? (
              <Text color="green"> {`> ${lastTranscript}`}</Text>
            ) : (
              <Text color="gray"> {audioEnabled ? "LISTENING..." : "DISABLED"}</Text>
            )}
            {audioLog.length > 0 ? (
              <Box flexDirection="column" marginTop={0}>
                <Text color="gray"> RECENT </Text>
                {audioLog.map((entry, i) => (
                  <Text key={i} color="gray">  {entry}</Text>
                ))}
              </Box>
            ) : null}
          </Box>
        </Box>

        {/* ═══ BROADCAST ═══ */}
        <Box flexDirection="column" borderStyle="single" borderColor={tvChannelActive || radioChannelActive ? "cyan" : "gray"} paddingX={1}>
          <Text color={tvChannelActive || radioChannelActive ? "cyan" : "gray"} bold> BROADCAST </Text>
          <Box gap={2}>
            <Text color={tvChannelActive ? "cyan" : "gray"}>
              {tvChannelActive ? "●" : "○"} TV {tvChannelActive ? "ON AIR" : "STANDBY"}  SENT {tvBroadcastCount}
            </Text>
            <Text color={radioChannelActive ? "cyan" : "gray"}>
              {radioChannelActive ? "●" : "○"} RADIO {radioChannelActive ? "ON AIR" : "STANDBY"}  SENT {radioBroadcastCount}  [{audioChunkSec}s]
            </Text>
          </Box>
        </Box>

      </Box>

      {/* Controls */}
      <Box paddingX={1} marginTop={0}>
        <Text color="green">
          [↑↓] NAV  [T] TOGGLE  [A] MIC  [1] TV  [2] RADIO  [[ ]] INTERVAL  [D] DELETE ALL  [Q] QUIT
        </Text>
      </Box>
    </Box>
  );
}

render(React.createElement(App));
