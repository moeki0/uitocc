#!/usr/bin/env bun
/**
 * tunr watch daemon — TUI for channel-based window monitoring
 */

import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import { Database } from "bun:sqlite";
import { join } from "path";
import { homedir } from "os";
import { dirname } from "path";
import { unlinkSync } from "fs";

// --- DB setup ---
const DATA_DIR = join(homedir(), "Library", "Application Support", "tunr");
const DB_PATH = join(DATA_DIR, "tunr.db");

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
try { db.run(`ALTER TABLE screen_states ADD COLUMN channel_names TEXT`); } catch {}

// Channel tables
db.run(`CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  include_audio INTEGER DEFAULT 0
)`);

db.run(`CREATE TABLE IF NOT EXISTS channel_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  title_pattern TEXT DEFAULT '%',
  UNIQUE(channel_id, app, title_pattern)
)`);

db.run(`CREATE TABLE IF NOT EXISTS channel_subscriptions (
  channel_name TEXT PRIMARY KEY,
  subscribed_at TEXT DEFAULT (datetime('now'))
)`);

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
  `INSERT INTO screen_states (timestamp, pid, window_index, app, window_title, texts, embedding, screenshot_path, channel_names) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// --- Channel DB helpers ---
function getChannels(): { id: number; name: string; include_audio: number }[] {
  return db.prepare(`SELECT id, name, include_audio FROM channels ORDER BY id`).all() as any[];
}

function getChannelWindowAssignments(): { channel_id: number; channel_name: string; app: string; title_pattern: string }[] {
  return db.prepare(
    `SELECT cw.channel_id, c.name as channel_name, cw.app, cw.title_pattern
     FROM channel_windows cw JOIN channels c ON c.id = cw.channel_id`
  ).all() as any[];
}

function getActiveSubscriptions(): string[] {
  return (db.prepare(`SELECT channel_name FROM channel_subscriptions`).all() as any[]).map(r => r.channel_name);
}

function matchChannelsForWindow(app: string, title: string, assignments: { channel_name: string; app: string; title_pattern: string }[]): string[] {
  const matched = new Set<string>();
  for (const a of assignments) {
    if (a.app === app) {
      if (a.title_pattern === "%" || title.includes(a.title_pattern.replace(/%/g, ""))) {
        matched.add(a.channel_name);
      }
    }
  }
  return [...matched];
}

// --- AX text helper ---
const AX_TEXT_PATH = join(dirname(process.execPath), "tunr-ax-text");
const AX_TEXT_FALLBACK = join(import.meta.dir, "tunr-ax-text");
const axTextBin = await Bun.file(AX_TEXT_PATH).exists() ? AX_TEXT_PATH : AX_TEXT_FALLBACK;

const EMBED_PATH = join(dirname(process.execPath), "tunr-embed");
const EMBED_FALLBACK = join(import.meta.dir, "tunr-embed");
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

interface TrackedWindow {
  pid: number;
  window_index: number;
  app: string;
  title: string;
  channels: string[]; // assigned channel names
  lastSeen: number;
}

const POLL_MS = 3000;

// --- React TUI ---
type Panel = "channels" | "windows";
type InputMode = "normal" | "create_channel";

function App() {
  const { exit } = useApp();
  const [windows, setWindows] = useState<Map<string, TrackedWindow>>(new Map());
  const windowsRef = useRef<Map<string, TrackedWindow>>(new Map());
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [recordCount, setRecordCount] = useState(0);
  const [audioSize, setAudioSize] = useState("0 MB");
  const [screenIntervalSec, setScreenIntervalSec] = useState(typeof _savedSettings.screenIntervalSec === "number" ? _savedSettings.screenIntervalSec : 5);
  const screenIntervalRef = useRef(typeof _savedSettings.screenIntervalSec === "number" ? _savedSettings.screenIntervalSec : 5);
  const [broadcastCount, setBroadcastCount] = useState(0);

  // Channel state
  const [channels, setChannels] = useState(getChannels());
  const [activePanel, setActivePanel] = useState<Panel>("channels");
  const [channelIndex, setChannelIndex] = useState(0);
  const [windowIndex, setWindowIndex] = useState(0);
  const [inputMode, setInputMode] = useState<InputMode>("normal");
  const [newChannelName, setNewChannelName] = useState("");
  const [subscriptions, setSubscriptions] = useState<string[]>(getActiveSubscriptions());

  // Refresh channels from DB periodically
  useEffect(() => {
    const iv = setInterval(() => {
      setChannels(getChannels());
      setSubscriptions(getActiveSubscriptions());
    }, 2000);
    return () => clearInterval(iv);
  }, []);

  // Update storage sizes every 10s
  useEffect(() => {
    function updateSizes() {
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

  // Audio state
  const [audioLog, setAudioLog] = useState<string[]>([]);
  const addAudioLog = (entry: string) => setAudioLog((prev) => [entry, ...prev].slice(0, 5));
  const [audioBroadcastCount, setAudioBroadcastCount] = useState(0);

  useEffect(() => { windowsRef.current = windows; }, [windows]);

  // Poll for windows
  useEffect(() => {
    let active = true;
    async function poll() {
      while (active) {
        const found = await getAllWindows();
        const now = Date.now();
        const assignments = getChannelWindowAssignments();

        setWindows((prev) => {
          const next = new Map(prev);
          const seenKeys = new Set<string>();

          for (const w of found) {
            const key = windowKey(w);
            seenKeys.add(key);
            const existing = next.get(key);
            const chans = matchChannelsForWindow(w.app, w.title, assignments);
            if (existing) {
              next.set(key, { ...existing, title: w.title, channels: chans, lastSeen: now });
            } else {
              next.set(key, {
                pid: w.pid,
                window_index: w.window_index,
                app: w.app,
                title: w.title,
                channels: chans,
                lastSeen: now,
              });
            }
          }

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

  // Record windows + broadcast to subscribed channels
  useEffect(() => {
    let active = true;
    const lastTexts = new Map<string, string>();
    const EVENT_MONITOR_PATH = join(dirname(process.execPath), "tunr-event-monitor");
    const EVENT_MONITOR_FALLBACK = join(import.meta.dir, "tunr-event-monitor");
    let pendingEventCapture = false;

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
      while (active) {
        if (!pendingEventCapture) {
          await Bun.sleep(screenIntervalRef.current * 1000);
        }
        pendingEventCapture = false;

        const found = await getAllWindows();
        const foundMap = new Map(found.map((w) => [windowKey(w), w]));
        const ts = new Date().toISOString();
        const assignments = getChannelWindowAssignments();
        const subs = getActiveSubscriptions();

        // Collect per-channel changed entries
        const perChannel = new Map<string, { app: string; title: string; texts: string[] }[]>();

        for (const [, w] of foundMap) {
          if (!w.texts || w.texts.length === 0) continue;
          const key = windowKey(w);

          const textsJson = JSON.stringify(w.texts);
          if (lastTexts.get(key) === textsJson) continue;
          lastTexts.set(key, textsJson);

          const chans = matchChannelsForWindow(w.app, w.title, assignments);
          const channelNamesJson = JSON.stringify(chans);

          const embedding = generateEmbedding(w.texts.join("\n"));
          insertStmt.run(ts, w.pid, w.window_index, w.app, w.title, textsJson, embedding, null, channelNamesJson);
          setRecordCount((c) => c + 1);

          // Group by subscribed channel for broadcast
          for (const ch of chans) {
            if (subs.includes(ch)) {
              if (!perChannel.has(ch)) perChannel.set(ch, []);
              perChannel.get(ch)!.push({ app: w.app, title: w.title, texts: w.texts });
            }
          }
        }

        // Write per-channel event files
        for (const [ch, entries] of perChannel) {
          const eventPath = join(DATA_DIR, `channel_event_${ch}.json`);
          await Bun.write(eventPath, JSON.stringify({ timestamp: ts, channel: ch, entries }));
          setBroadcastCount((c) => c + 1);
        }
      }
    }
    record();
    return () => { active = false; };
  }, []);

  // Audio capture & transcription
  const [audioEnabled, setAudioEnabled] = useState(true);
  const audioEnabledRef = useRef(true);
  const [audioStatus, setAudioStatus] = useState<string>("starting");
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [audioChunkSec, setAudioChunkSec] = useState(savedAudioChunkSec);
  const audioChunkRef = useRef(savedAudioChunkSec);
  const audioProcRef = useRef<any>(null);

  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);
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
    const AUDIO_CAPTURE_PATH = join(dirname(process.execPath), "tunr-audio-capture");
    const AUDIO_CAPTURE_FALLBACK = join(import.meta.dir, "tunr-audio-capture");

    async function startAudio() {
      const audioBin = await Bun.file(AUDIO_CAPTURE_PATH).exists() ? AUDIO_CAPTURE_PATH : AUDIO_CAPTURE_FALLBACK;
      if (!await Bun.file(audioBin).exists()) {
        setAudioStatus("no binary");
        return;
      }

      const whisperCheck = Bun.spawnSync(["which", "whisper-cli"], { stdout: "pipe", stderr: "pipe" });
      if (whisperCheck.exitCode !== 0) {
        setAudioStatus("disabled — whisper-cpp not installed");
        setAudioEnabled(false);
        return;
      }
      const modelPath = join(homedir(), ".cache", "whisper-cpp-small.bin");
      if (!await Bun.file(modelPath).exists()) {
        setAudioStatus("disabled — model not found");
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
          stdout: "pipe", stderr: "pipe",
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
              const mp = join(homedir(), ".cache", "whisper-cpp-small.bin");
              const wp = Bun.spawnSync([
                "whisper-cli", "-m", mp, "-l", "ja", "-f", chunk.file, "-np", "-nt",
              ], { stdout: "pipe", stderr: "pipe" });
              const transcript = wp.stdout.toString().trim();
              if (transcript) {
                insertAudioStmt.run(chunk.timestamp, chunk.file, transcript);
                setLastTranscript(transcript.slice(0, 80));
                addAudioLog(`${chunk.timestamp.slice(11, 19)} ${transcript.slice(0, 40)}`);
                // Write audio event for channels that include audio and are subscribed
                const subs = getActiveSubscriptions();
                const audioChannels = getChannels().filter(c => c.include_audio && subs.includes(c.name));
                for (const ch of audioChannels) {
                  const audioEventPath = join(DATA_DIR, `channel_audio_${ch.name}.json`);
                  await Bun.write(audioEventPath, JSON.stringify({
                    timestamp: chunk.timestamp,
                    channel: ch.name,
                    transcript,
                  }));
                  setAudioBroadcastCount((c) => c + 1);
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

  // Handle input
  const allWindows = [...windows.values()];

  useInput((input, key) => {
    if (inputMode === "create_channel") return; // TextInput handles input

    if (input === "q" || (key.ctrl && input === "c")) {
      if (audioProcRef.current) audioProcRef.current.kill();
      db.close();
      process.exit(0);
    }

    // Panel switching
    if (key.tab) {
      setActivePanel((p) => p === "channels" ? "windows" : "channels");
      return;
    }

    // Audio toggle
    if (input === "a" || input === "A") {
      setAudioEnabled((prev) => !prev);
      return;
    }

    // Interval
    if (input === "[") { setScreenIntervalSec((p: number) => Math.max(3, p - 1)); return; }
    if (input === "]") { setScreenIntervalSec((p: number) => Math.min(30, p + 1)); return; }

    // Delete all data
    if (input === "d" || input === "D") {
      if (deleteConfirm) {
        db.run("DELETE FROM screen_states");
        db.run("DELETE FROM audio_transcripts");
        try { Bun.spawnSync(["find", AUDIO_DIR, "-name", "*.wav", "-delete"], { stdout: "pipe", stderr: "pipe" }); } catch {}
        setRecordCount(0);
        setBroadcastCount(0);
        setAudioBroadcastCount(0);
        setAudioSize("0B");
        setDeleteConfirm(false);
      } else {
        setDeleteConfirm(true);
        setTimeout(() => setDeleteConfirm(false), 3000);
      }
      return;
    }
    setDeleteConfirm(false);

    if (activePanel === "channels") {
      if (key.upArrow) { setChannelIndex((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setChannelIndex((p) => Math.min(channels.length - 1, p + 1)); return; }

      // Create channel
      if (input === "c" || input === "C") {
        setInputMode("create_channel");
        setNewChannelName("");
        return;
      }

      // Delete channel
      if (input === "x" || input === "X") {
        if (channelIndex >= 0 && channelIndex < channels.length) {
          db.run(`DELETE FROM channels WHERE id = ?`, channels[channelIndex].id);
          setChannels(getChannels());
          setChannelIndex((p) => Math.min(p, channels.length - 2));
        }
        return;
      }

      // Toggle audio for channel
      if (input === "a" || input === "A") {
        // 'a' in channels panel toggles channel audio, not global audio
        return; // handled above already for global audio
      }
      if (input === "o" || input === "O") {
        if (channelIndex >= 0 && channelIndex < channels.length) {
          const ch = channels[channelIndex];
          db.run(`UPDATE channels SET include_audio = ? WHERE id = ?`, ch.include_audio ? 0 : 1, ch.id);
          setChannels(getChannels());
        }
        return;
      }
    }

    if (activePanel === "windows") {
      if (key.upArrow) { setWindowIndex((p) => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setWindowIndex((p) => Math.min(allWindows.length - 1, p + 1)); return; }

      // Assign window to channel by number key (1-9)
      const num = parseInt(input);
      if (num >= 1 && num <= 9 && windowIndex >= 0 && windowIndex < allWindows.length) {
        const chIdx = num - 1;
        if (chIdx < channels.length) {
          const w = allWindows[windowIndex];
          const ch = channels[chIdx];
          try {
            db.run(
              `INSERT OR IGNORE INTO channel_windows (channel_id, app, title_pattern) VALUES (?, ?, '%')`,
              ch.id, w.app
            );
          } catch {}
          // Refresh window channels
          const assignments = getChannelWindowAssignments();
          setWindows((prev) => {
            const next = new Map(prev);
            for (const [k, tw] of next) {
              next.set(k, { ...tw, channels: matchChannelsForWindow(tw.app, tw.title, assignments) });
            }
            return next;
          });
        }
        return;
      }

      // Remove window from selected channel (0 key)
      if (input === "0" && windowIndex >= 0 && windowIndex < allWindows.length && channelIndex >= 0 && channelIndex < channels.length) {
        const w = allWindows[windowIndex];
        const ch = channels[channelIndex];
        db.run(`DELETE FROM channel_windows WHERE channel_id = ? AND app = ?`, ch.id, w.app);
        const assignments = getChannelWindowAssignments();
        setWindows((prev) => {
          const next = new Map(prev);
          for (const [k, tw] of next) {
            next.set(k, { ...tw, channels: matchChannelsForWindow(tw.app, tw.title, assignments) });
          }
          return next;
        });
        return;
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
  const recBlink = now.getSeconds() % 2 === 0;

  // Channel window counts
  const assignments = getChannelWindowAssignments();
  const channelWindowCounts = new Map<string, number>();
  for (const ch of channels) {
    channelWindowCounts.set(ch.name, assignments.filter(a => a.channel_name === ch.name).length);
  }

  return (
    <Box flexDirection="column" paddingX={1} height={rows}>
      {/* Header */}
      <Box borderStyle="single" borderColor="green" paddingX={1} justifyContent="space-between">
        <Text color="green" bold> TUNR CONTROL ROOM </Text>
        <Text color="green">{dateStr} {clock}</Text>
      </Box>

      <Box flexDirection="column" marginTop={0} flexGrow={1}>

        {/* CHANNELS */}
        <Box flexDirection="column" borderStyle="single" borderColor={activePanel === "channels" ? "cyan" : "green"} paddingX={1}>
          <Box gap={2}>
            <Text color={activePanel === "channels" ? "cyan" : "green"} bold> CHANNELS </Text>
            <Text color="gray">[C] Create  [X] Delete  [O] Toggle audio</Text>
          </Box>
          {inputMode === "create_channel" ? (
            <Box>
              <Text color="yellow">New channel: </Text>
              <TextInput
                value={newChannelName}
                onChange={setNewChannelName}
                onSubmit={(val: string) => {
                  const name = val.trim();
                  if (name) {
                    try { db.run(`INSERT INTO channels (name) VALUES (?)`, name); } catch {}
                    setChannels(getChannels());
                  }
                  setInputMode("normal");
                  setNewChannelName("");
                }}
              />
            </Box>
          ) : null}
          {channels.length > 0 ? (
            <Box flexDirection="column">
              {channels.map((ch, i) => {
                const isSelected = activePanel === "channels" && i === channelIndex;
                const isSub = subscriptions.includes(ch.name);
                const wCount = channelWindowCounts.get(ch.name) || 0;
                return (
                  <Box key={ch.id}>
                    <Text color={isSelected ? "cyan" : "green"}>
                      {isSelected ? "▸ " : "  "}
                    </Text>
                    <Text color="green" bold>{String(i + 1)}.</Text>
                    <Text color="white"> {ch.name}</Text>
                    <Text color="gray"> [{wCount} windows]</Text>
                    <Text color={ch.include_audio ? "green" : "gray"}> [audio:{ch.include_audio ? "on" : "off"}]</Text>
                    {isSub ? <Text color="cyan"> [SUB]</Text> : null}
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Text color="yellow"> No channels. Press C to create one.</Text>
          )}
        </Box>

        {/* WINDOWS */}
        <Box flexDirection="column" borderStyle="single" borderColor={activePanel === "windows" ? "cyan" : "green"} paddingX={1}>
          <Box gap={2}>
            <Text color={activePanel === "windows" ? "cyan" : "green"} bold> WINDOWS </Text>
            <Text color="green">
              {recBlink ? "●" : "○"} REC {recordCount} [{screenIntervalSec}s]
            </Text>
            <Text color="gray">[1-9] Assign  [0] Remove</Text>
          </Box>
          {allWindows.length > 0 ? (
            <Box flexDirection="column">
              {allWindows.map((w, i) => {
                const isSelected = activePanel === "windows" && i === windowIndex;
                const chTags = w.channels.length > 0 ? w.channels.join(",") : "";
                return (
                  <Box key={windowKey(w)}>
                    <Text color={isSelected ? "cyan" : "green"}>
                      {isSelected ? "▸ " : "  "}
                    </Text>
                    <Text color="white">{w.app}</Text>
                    <Text color="gray"> | {(w.title || "untitled").slice(0, 35)}</Text>
                    {chTags ? (
                      <Text color="cyan"> [{chTags}]</Text>
                    ) : (
                      <Text color="gray"> (none)</Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Text color="yellow"> No windows detected</Text>
          )}
        </Box>

        {/* AUDIO */}
        <Box flexDirection="column" borderStyle="single" borderColor={audioEnabled ? "green" : "gray"} paddingX={1}>
          <Box gap={2}>
            <Text color={audioEnabled ? "green" : "gray"} bold> AUDIO </Text>
            <Text color={audioEnabled ? "green" : "red"}>
              {audioEnabled && audioStatus === "recording" ? (recBlink ? "●" : "○") : "○"} {audioEnabled ? audioStatus.toUpperCase() : "OFF"} [{audioSize}]
            </Text>
          </Box>
          {audioEnabled && lastTranscript ? (
            <Text color="green"> {`> ${lastTranscript}`}</Text>
          ) : null}
        </Box>

        {/* STATUS */}
        <Box paddingX={1} gap={2}>
          <Text color="green">BROADCAST: {broadcastCount} screen, {audioBroadcastCount} audio</Text>
          <Text color="gray">SUBS: {subscriptions.length > 0 ? subscriptions.join(", ") : "none"}</Text>
        </Box>
      </Box>

      {/* Controls */}
      <Box paddingX={1} marginTop={0}>
        <Text color="green">
          {deleteConfirm
            ? <Text color="red" bold>Press D again to DELETE ALL DATA</Text>
            : "[Tab] Panel  [↑↓] NAV  [A] MIC  [[ ]] INTERVAL  [D] DELETE  [Q] QUIT"}
        </Text>
      </Box>
    </Box>
  );
}

render(React.createElement(App));
