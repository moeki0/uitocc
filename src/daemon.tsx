#!/usr/bin/env bun
/**
 * tunr start — Capture-first TUI daemon
 */

import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import { join } from "path";
import { dirname } from "path";
import { homedir } from "os";
import { unlinkSync } from "fs";

import type { TrackedSource, Capture, DayCount } from "./lib/types";
import type { View, SettingsTab, FocusArea } from "./lib/types";
import { VERSION, DB_PATH, SETTINGS_PATH, AUDIO_DIR, AUDIO_SOURCE_KEY, POLL_MS, savedAudioChunkSec, savedSettings } from "./lib/constants";
import { db, insertStmt, insertAudioStmt, localDateStr, getRecentCaptures, getDailyCounts, getHourlyCountsForDate, getCapturesForDate } from "./lib/db";
import { getChannels, getActiveSubscriptions } from "./lib/rules";
import { generateEmbedding, getAllWindows, windowKey, cosineSimilarity } from "./lib/capture";
import { checkForUpdate } from "./lib/update-check";

// ===== TUI =====

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;

  // --- State ---
  const [view, setView] = useState<View>("feed");
  const [windows, setWindows] = useState<Map<string, TrackedSource>>(new Map());
  const windowsRef = useRef<Map<string, TrackedSource>>(new Map());
  const [recordCount, setRecordCount] = useState(
    () => (db.prepare("SELECT count(*) as c FROM screen_states").get() as any).c
  );
  const [screenIntervalSec, setScreenIntervalSec] = useState(
    typeof savedSettings.screenIntervalSec === "number" ? savedSettings.screenIntervalSec : 5
  );
  const screenIntervalRef = useRef(screenIntervalSec);
  const [changeThreshold, setChangeThreshold] = useState(
    typeof savedSettings.changeThreshold === "number" ? savedSettings.changeThreshold : 0.5
  );
  const changeThresholdRef = useRef(changeThreshold);

  // Audio
  const [audioStatus, setAudioStatus] = useState("starting");
  const [lastTranscript, setLastTranscript] = useState("");
  const [audioChunkSec, setAudioChunkSec] = useState(savedAudioChunkSec);
  const audioChunkRef = useRef(savedAudioChunkSec);
  const audioProcRef = useRef<any>(null);
  const [audioBroadcastCount, setAudioBroadcastCount] = useState(
    () => (db.prepare("SELECT count(*) as c FROM audio_transcripts").get() as any).c
  );

  // Audio enabled is derived from the audio source having channels assigned
  const audioSource = windows.get(AUDIO_SOURCE_KEY);
  const audioEnabled = (audioSource?.channels.length ?? 0) > 0;
  const audioEnabledRef = useRef(false);

  // Initialize audio virtual source on mount
  useEffect(() => {
    setWindows((prev) => {
      if (prev.has(AUDIO_SOURCE_KEY)) return prev;
      const next = new Map(prev);
      next.set(AUDIO_SOURCE_KEY, {
        pid: 0, window_index: 0,
        app: "Audio", title: "System Audio",
        urls: [],
        channels: [],
        lastSeen: Date.now(),
        virtual: true,
      });
      return next;
    });
  }, []);

  // Channels (each channel has its own rules)
  const [channels, setChannels] = useState(getChannels());
  const [subscriptions, setSubscriptions] = useState<string[]>(getActiveSubscriptions());

  // Feed state
  const [focusArea, setFocusArea] = useState<FocusArea>("feed");
  const [feedIndex, setFeedIndex] = useState(0);
  const [feedScroll, setFeedScroll] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [channelFilter, setChannelFilter] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  const [searchMode, setSearchMode] = useState(false);
  const [captures, setCaptures] = useState<Capture[]>([]);

  // Settings state
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsIndex, setSettingsIndex] = useState(0);
  const [channelCreateMode, setChannelCreateMode] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");

  // Sources panel state
  const [sourcesIndex, setSourcesIndex] = useState(0);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [channelPickerIndex, setChannelPickerIndex] = useState(0);

  // Calendar state
  const [calDays, setCalDays] = useState<DayCount[]>([]);
  const [calCursorX, setCalCursorX] = useState(0); // week
  const [calCursorY, setCalCursorY] = useState(0); // day of week (0=Sun)
  const [calSelectedDate, setCalSelectedDate] = useState<string | null>(null);
  const [calCaptures, setCalCaptures] = useState<Capture[]>([]);
  const [calFeedIndex, setCalFeedIndex] = useState(0);
  const [calFeedScroll, setCalFeedScroll] = useState(0);
  const [calHourly, setCalHourly] = useState<{ hour: number; count: number }[]>([]);

  // Detail state
  const [detailCapture, setDetailCapture] = useState<Capture | null>(null);

  // Delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Update check
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  useEffect(() => {
    checkForUpdate(VERSION).then(setUpdateAvailable);
  }, []);

  // Storage size
  const [dbSizeMB, setDbSizeMB] = useState(0);

  // Clock
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const recBlink = now.getSeconds() % 2 === 0;

  // Sync refs
  useEffect(() => { windowsRef.current = windows; }, [windows]);
  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);

  // Keep audio source's lastSeen fresh so it doesn't get cleaned up
  useEffect(() => {
    const iv = setInterval(() => {
      setWindows((prev) => {
        const src = prev.get(AUDIO_SOURCE_KEY);
        if (!src) return prev;
        const next = new Map(prev);
        next.set(AUDIO_SOURCE_KEY, { ...src, lastSeen: Date.now() });
        return next;
      });
    }, 5000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    audioChunkRef.current = audioChunkSec;
    Bun.write(SETTINGS_PATH, JSON.stringify({ audioChunkSec, screenIntervalSec, changeThreshold }, null, 2));
  }, [audioChunkSec]);
  useEffect(() => {
    screenIntervalRef.current = screenIntervalSec;
    Bun.write(SETTINGS_PATH, JSON.stringify({ audioChunkSec, screenIntervalSec, changeThreshold }, null, 2));
  }, [screenIntervalSec]);
  useEffect(() => {
    changeThresholdRef.current = changeThreshold;
    Bun.write(SETTINGS_PATH, JSON.stringify({ audioChunkSec, screenIntervalSec, changeThreshold }, null, 2));
  }, [changeThreshold]);

  // Refresh channels + subscriptions + captures + storage size periodically
  useEffect(() => {
    const iv = setInterval(() => {
      setChannels(getChannels());
      setSubscriptions(getActiveSubscriptions());
      const audioSrc = windowsRef.current.get(AUDIO_SOURCE_KEY);
      const audioChans = audioSrc?.channels ?? [];
      setCaptures(getRecentCaptures(500, typeFilter, channelFilter, searchQuery, 0, audioChans));
      try { setDbSizeMB(Math.round(Bun.file(DB_PATH).size / 1024 / 1024 * 10) / 10); } catch {}
    }, 2000);
    return () => clearInterval(iv);
  }, [typeFilter, channelFilter, searchQuery]);

  // Initial capture load
  useEffect(() => {
    const audioSrc = windowsRef.current.get(AUDIO_SOURCE_KEY);
    const audioChans = audioSrc?.channels ?? [];
    setCaptures(getRecentCaptures(500, typeFilter, channelFilter, searchQuery, 0, audioChans));
    setFeedIndex(0);
    setFeedScroll(0);
  }, [typeFilter, channelFilter, searchQuery]);

  // --- Window polling ---
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
            const urls = w.urls ?? [];
            if (existing) {
              next.set(key, { ...existing, title: w.title, urls, lastSeen: now });
            } else {
              next.set(key, {
                pid: w.pid, window_index: w.window_index,
                app: w.app, title: w.title, urls,
                channels: [], lastSeen: now,
              });
            }
          }

          for (const [key, tw] of next) {
            if (!seenKeys.has(key) && now - tw.lastSeen > 10000) next.delete(key);
          }
          return next;
        });

        await Bun.sleep(POLL_MS);
      }
    }
    poll();
    return () => { active = false; };
  }, []);

  // --- Recording ---
  useEffect(() => {
    let active = true;
    const lastEmbeddings = new Map<string, Buffer>();

    async function record() {
      while (active) {
        await Bun.sleep(screenIntervalRef.current * 1000);

        const found = await getAllWindows();
        const foundMap = new Map(found.map((w) => [windowKey(w), w]));
        const ts = new Date().toISOString();
        const currentWindows = windowsRef.current;

        for (const [, w] of foundMap) {
          if (!w.texts || w.texts.length === 0) continue;
          const key = windowKey(w);

          const tw = currentWindows.get(key);
          if (!tw || tw.channels.length === 0) continue;

          const embedding = generateEmbedding(w.texts.join("\n"));

          // Filter by embedding distance (normalized by text length)
          const prev = lastEmbeddings.get(key);
          if (embedding && prev) {
            const sim = cosineSimilarity(prev, embedding);
            const distance = 1 - sim;
            const textLen = w.texts.join("\n").length;
            const BASE_LEN = 500;
            const scale = Math.log(Math.max(textLen, 10)) / Math.log(BASE_LEN);
            const effectiveThreshold = changeThresholdRef.current * scale;
            if (distance < effectiveThreshold) continue;
          }
          if (embedding) lastEmbeddings.set(key, embedding);

          const textsJson = JSON.stringify(w.texts);
          const channelNamesJson = JSON.stringify(tw.channels);
          insertStmt.run(ts, w.pid, w.window_index, w.app, w.title, textsJson, embedding, null, channelNamesJson);
          setRecordCount((c) => c + 1);
        }
      }
    }
    record();
    return () => { active = false; };
  }, []);

  // --- Audio ---
  useEffect(() => {
    let active = true;
    const AUDIO_CAPTURE_PATH = join(dirname(process.execPath), "tunr-audio-capture");
    const AUDIO_CAPTURE_FALLBACK = join(import.meta.dir, "..", "tunr-audio-capture");

    async function startAudio() {
      const audioBin = await Bun.file(AUDIO_CAPTURE_PATH).exists() ? AUDIO_CAPTURE_PATH : AUDIO_CAPTURE_FALLBACK;
      if (!await Bun.file(audioBin).exists()) { setAudioStatus("no binary"); return; }

      const whisperCheck = Bun.spawnSync(["which", "whisper-cli"], { stdout: "pipe", stderr: "pipe" });
      if (whisperCheck.exitCode !== 0) { setAudioStatus("no whisper"); return; }
      const modelPath = join(homedir(), ".cache", "whisper-cpp-small.bin");
      if (!await Bun.file(modelPath).exists()) { setAudioStatus("no model"); return; }

      while (active) {
        if (!audioEnabledRef.current) { setAudioStatus("off"); await Bun.sleep(1000); continue; }

        setAudioStatus("recording");
        const proc = Bun.spawn([audioBin, AUDIO_DIR, String(audioChunkRef.current)], { stdout: "pipe", stderr: "pipe" });
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
                "whisper-cli", "-m", mp, "-l", "auto", "-f", chunk.file, "-np", "-nt",
              ], { stdout: "pipe", stderr: "pipe" });
              const transcript = wp.stdout.toString().trim();
              try { unlinkSync(chunk.file); } catch {}
              if (transcript) {
                insertAudioStmt.run(chunk.timestamp, chunk.file, transcript);
                setLastTranscript(transcript.slice(0, 80));
                setAudioBroadcastCount((c) => c + 1);
              }
            } catch {}
          }
        }
        proc.kill();
        audioProcRef.current = null;
      }
    }
    startAudio();

    // Audio files are deleted immediately after transcription; no periodic cleanup needed.
    return () => { active = false; };
  }, []);

  // --- Derived data ---
  const allSources = [...windows.values()];
  const assignedCount = allSources.filter(w => w.channels.length > 0).length;

  // Toggle channel assignment for a window
  const toggleChannel = (wKey: string, chName: string) => {
    setWindows((prev) => {
      const next = new Map(prev);
      const w = next.get(wKey);
      if (!w) return prev;
      const has = w.channels.includes(chName);
      next.set(wKey, { ...w, channels: has ? w.channels.filter(c => c !== chName) : [...w.channels, chName] });
      return next;
    });
  };

  // --- Input handling ---
  useInput((input, key) => {
    // Search mode: TextInput handles everything
    if (searchMode) return;
    // Channel create mode
    if (channelCreateMode) return;
    // Channel picker mode
    if (channelPickerOpen) {
      const chList = getChannels();
      if (key.escape) { setChannelPickerOpen(false); return; }
      if (key.upArrow) { setChannelPickerIndex(p => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setChannelPickerIndex(p => Math.min(chList.length - 1, p + 1)); return; }
      if (key.return && channelPickerIndex < chList.length) {
        const w = allSources[sourcesIndex];
        if (w) {
          const wKey = w.virtual ? AUDIO_SOURCE_KEY : windowKey(w);
          toggleChannel(wKey, chList[channelPickerIndex].name);
        }
        setChannelPickerOpen(false);
      }
      return;
    }

    // Global: quit
    if (input === "q" || (key.ctrl && input === "c")) {
      if (audioProcRef.current) audioProcRef.current.kill();
      db.close();
      process.exit(0);
    }

    // View switching
    if (view === "detail") {
      if (key.escape || input === "q") {
        setView(calSelectedDate ? "calendar" : "feed");
        return;
      }
      return;
    }

    if (view === "calendar") {
      if (key.escape) {
        if (calSelectedDate) {
          setCalSelectedDate(null);
          setCalCaptures([]);
          setCalFeedIndex(0);
          setCalFeedScroll(0);
        } else {
          setView("feed");
        }
        return;
      }

      if (calSelectedDate) {
        // Browsing a day's captures
        const calFeedH = Math.max(4, rows - 14);
        if (key.upArrow) {
          setCalFeedIndex(p => {
            const next = Math.max(0, p - 1);
            setCalFeedScroll(s => next < s ? next : s);
            return next;
          });
          return;
        }
        if (key.downArrow) {
          setCalFeedIndex(p => {
            const next = Math.min(calCaptures.length - 1, p + 1);
            setCalFeedScroll(s => next >= s + calFeedH ? next - calFeedH + 1 : s);
            return next;
          });
          return;
        }
        if (key.return && calFeedIndex < calCaptures.length) {
          setDetailCapture(calCaptures[calFeedIndex]);
          setView("detail");
          return;
        }
        return;
      }

      // Navigating the heatmap grid
      const weeks = Math.max(1, Math.ceil(calDays.length / 7));
      if (key.leftArrow) { setCalCursorX(p => Math.max(0, p - 1)); return; }
      if (key.rightArrow) { setCalCursorX(p => Math.min(weeks - 1, p + 1)); return; }
      if (key.upArrow) { setCalCursorY(p => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setCalCursorY(p => Math.min(6, p + 1)); return; }
      if (key.return) {
        const idx = calCursorX * 7 + calCursorY;
        if (idx < calDays.length) {
          const date = calDays[idx].date;
          setCalSelectedDate(date);
          setCalCaptures(getCapturesForDate(date));
          setCalHourly(getHourlyCountsForDate(date));
          setCalFeedIndex(0);
          setCalFeedScroll(0);
        }
        return;
      }
      return;
    }

    if (view === "settings") {
      if (key.escape) { setView("feed"); return; }

      // Tab switching in settings
      if (key.tab) {
        const tabs: SettingsTab[] = ["general", "channels"];
        const idx = tabs.indexOf(settingsTab);
        setSettingsTab(tabs[(idx + 1) % tabs.length]);
        setSettingsIndex(0);
        return;
      }

      if (key.upArrow) { setSettingsIndex(p => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setSettingsIndex(p => p + 1); return; }

      if (settingsTab === "general") {
        if (settingsIndex === 0 && (input === "[" || input === "]")) {
          setScreenIntervalSec(p => input === "[" ? Math.max(3, p - 1) : Math.min(30, p + 1));
          return;
        }
        if (settingsIndex === 1 && (input === "[" || input === "]")) {
          setChangeThreshold(p => {
            const v = input === "[" ? Math.max(0, Math.round((p - 0.05) * 100) / 100) : Math.min(1, Math.round((p + 0.05) * 100) / 100);
            return v;
          });
          return;
        }
        if (settingsIndex === 2 && (input === "[" || input === "]")) {
          setAudioChunkSec(p => input === "[" ? Math.max(5, p - 1) : Math.min(60, p + 1));
          return;
        }
        if (settingsIndex === 3 && key.return) {
          if (deleteConfirm) {
            db.run("DELETE FROM screen_states");
            db.run("DELETE FROM audio_transcripts");
            try { Bun.spawnSync(["find", AUDIO_DIR, "-name", "*.wav", "-delete"], { stdout: "pipe", stderr: "pipe" }); } catch {}
            setRecordCount(0); setAudioBroadcastCount(0);
            setDeleteConfirm(false);
          } else {
            setDeleteConfirm(true);
            setTimeout(() => setDeleteConfirm(false), 3000);
          }
          return;
        }
      }

      if (settingsTab === "channels") {
        const chList = getChannels();
        if (input === "c" || input === "C") { setChannelCreateMode(true); setNewChannelName(""); return; }
        if ((input === "x" || input === "X") && settingsIndex < chList.length) {
          db.run(`DELETE FROM channels WHERE id = ?`, chList[settingsIndex].id);
          setChannels(getChannels());
          return;
        }
      }
      return;
    }

    // === Feed view ===

    // Settings
    if (input === "s" || input === "S") { setView("settings"); setSettingsIndex(0); return; }

    // Calendar
    if (input === "c" || input === "C") {
      const days = getDailyCounts(16);
      setCalDays(days);
      // Position cursor on today
      const todayStr = localDateStr(new Date());
      const todayIdx = days.findIndex(d => d.date === todayStr);
      if (todayIdx >= 0) { setCalCursorX(Math.floor(todayIdx / 7)); setCalCursorY(todayIdx % 7); }
      setCalSelectedDate(null);
      setView("calendar");
      return;
    }

    // Search
    if (input === "/") { setSearchMode(true); return; }

    // Toggle type filter
    if (input === "1") {
      setTypeFilter(p => p.includes("screen") ? p.filter(t => t !== "screen") : [...p, "screen"]);
      return;
    }
    if (input === "2") {
      setTypeFilter(p => p.includes("audio") ? p.filter(t => t !== "audio") : [...p, "audio"]);
      return;
    }

    // Toggle channel filter (3-9 mapped to channels)
    if (input >= "3" && input <= "9") {
      const chIdx = parseInt(input) - 3;
      const chList = getChannels();
      if (chIdx < chList.length) {
        const chName = chList[chIdx].name;
        setChannelFilter(p => p.includes(chName) ? p.filter(c => c !== chName) : [...p, chName]);
      }
      return;
    }

    // Focus area switching
    if (key.tab) {
      if (allSources.length > 0) {
        setFocusArea(p => p === "feed" ? "sources" : "feed");
      }
      return;
    }

    if (focusArea === "sources") {
      if (key.upArrow) { setSourcesIndex(p => Math.max(0, p - 1)); return; }
      if (key.downArrow) { setSourcesIndex(p => Math.min(allSources.length - 1, p + 1)); return; }
      if (key.return) {
        if (sourcesIndex < allSources.length) {
          const chList = getChannels();
          if (chList.length === 0) return;
          if (chList.length === 1) {
            // Single channel: toggle directly
            const w = allSources[sourcesIndex];
            const wKey = w.virtual ? AUDIO_SOURCE_KEY : windowKey(w);
            toggleChannel(wKey, chList[0].name);
          } else {
            // Multiple channels: open picker
            setChannelPickerOpen(true);
            setChannelPickerIndex(0);
          }
        }
        return;
      }
    }

    if (focusArea === "feed") {
      if (key.upArrow) {
        setFeedIndex(p => {
          const next = Math.max(0, p - 1);
          setFeedScroll(s => next < s ? next : s);
          return next;
        });
        return;
      }
      if (key.downArrow) {
        setFeedIndex(p => {
          const next = Math.min(captures.length - 1, p + 1);
          setFeedScroll(s => next >= s + feedHeight ? next - feedHeight + 1 : s);
          return next;
        });
        return;
      }
      if (key.return && feedIndex < captures.length) {
        setDetailCapture(captures[feedIndex]);
        setView("detail");
        return;
      }
    }
  });

  // ===== Render =====

  // --- Sources Panel ---
  const SourcesBar = () => {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={2}>
          <Text bold color={focusArea === "sources" ? "magenta" : "gray"}>SOURCES</Text>
          <Text color="gray">{assignedCount}/{allSources.length} assigned</Text>
        </Box>
        {allSources.map((w, i) => {
          const sel = focusArea === "sources" && i === sourcesIndex;
          const assigned = w.channels.length > 0;
          return (
            <Box key={w.virtual ? AUDIO_SOURCE_KEY : windowKey(w)} paddingLeft={1}>
              <Text wrap="truncate-end">
                <Text color={sel ? "magenta" : "gray"}>{sel ? "▸" : " "} </Text>
                <Text color={assigned ? "white" : "gray"} dimColor={!assigned}>{w.app}</Text>
                <Text color="gray" dimColor={!assigned}> · {(w.title || "untitled").slice(0, 10)}</Text>
                {assigned
                  ? <Text color="magenta"> [{w.channels.join(",")}]</Text>
                  : <Text color="gray" dimColor> —</Text>
                }
              </Text>
            </Box>
          );
        })}
        {channelPickerOpen && (
          <Box flexDirection="column" paddingLeft={2} marginTop={0}>
            <Text color="magenta" bold>Assign channel:</Text>
            {channels.map((ch, i) => {
              const sel = i === channelPickerIndex;
              const w = allSources[sourcesIndex];
              const has = w?.channels.includes(ch.name);
              return (
                <Box key={ch.id} paddingLeft={1}>
                  <Text color={sel ? "magenta" : "gray"}>{sel ? "▸" : " "} {ch.name} {has ? "✓" : ""}</Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    );
  };

  // --- Filter Bar ---
  const FilterBar = () => (
    <Box paddingX={1} gap={1} flexWrap="wrap">
      <Text
        color={typeFilter.includes("screen") ? "white" : "gray"}
        inverse={typeFilter.includes("screen")}
      >[1] ▣ screen</Text>
      <Text
        color={typeFilter.includes("audio") ? "white" : "gray"}
        inverse={typeFilter.includes("audio")}
      >[2] ♪ audio</Text>
      <Text color="gray">│</Text>
      {channels.map((ch, i) => (
        <Text
          key={ch.name}
          color={channelFilter.includes(ch.name) ? "magenta" : "gray"}
          inverse={channelFilter.includes(ch.name)}
        >[{i + 3}] {ch.name}</Text>
      ))}
      <Text color="gray">│</Text>
      {searchMode ? (
        <Box>
          <Text color="magenta">/</Text>
          <TextInput
            value={searchQuery}
            onChange={setSearchQuery}
            onSubmit={() => setSearchMode(false)}
          />
        </Box>
      ) : (
        <Text color="gray">[/] {searchQuery || "search..."}</Text>
      )}
    </Box>
  );

  // --- Capture Feed ---
  const feedHeight = Math.max(4, rows - 9 - (allSources.length > 0 ? allSources.length + 1 : 0));
  const visibleCaptures = captures.slice(feedScroll, feedScroll + feedHeight);

  const formatTime = (ts: string) => {
    const today = localDateStr(new Date());
    const date = ts.slice(0, 10);
    if (date === today) return ts.slice(11, 19);
    return date.slice(5) + " " + ts.slice(11, 16);
  };

  const CaptureRow = ({ cap, index }: { cap: Capture; index: number }) => {
    const actualIndex = feedScroll + index;
    const sel = focusArea === "feed" && actualIndex === feedIndex;
    const time = formatTime(cap.timestamp);
    const isAudio = cap.type === "audio";
    const chTags = cap.channels.length > 0 ? cap.channels.join(",") : "";
    const maxExcerpt = Math.max(10, cols - 50 - cap.app.length - (chTags ? chTags.length + 2 : 1));
    return (
      <Box paddingLeft={1}>
        <Text color={sel ? "magenta" : "gray"}>{sel ? "▸" : " "} </Text>
        <Text color="gray" dimColor>{time} </Text>
        <Text color={isAudio ? "magenta" : "cyan"}>{isAudio ? "♪" : "▣"} </Text>
        <Text color="white" bold>{cap.app} </Text>
        <Text color="gray" wrap="truncate-end">{cap.excerpt.slice(0, maxExcerpt)} </Text>
        {chTags ? <Text color="magenta">→{chTags}</Text> : <Text color="gray" dimColor>⊘</Text>}
      </Box>
    );
  };

  const Feed = () => (
    <Box flexDirection="column" flexGrow={1}>
      {visibleCaptures.length === 0 ? (
        <Box paddingX={2} paddingY={1}>
          <Text color="gray">No captures yet. Recording...</Text>
        </Box>
      ) : (
        visibleCaptures.map((cap, i) => (
          <CaptureRow key={cap.id} cap={cap} index={i} />
        ))
      )}
    </Box>
  );

  // --- Detail View ---
  if (view === "detail" && detailCapture) {
    const cap = detailCapture;
    const isAudio = cap.type === "audio";
    return (
      <Box flexDirection="column" paddingX={1} height={rows}>
        <Box paddingX={1} justifyContent="space-between">
          <Text bold color="magenta">tunr</Text>
          <Text color="gray">[Esc] back</Text>
        </Box>
        <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1} paddingY={0} marginX={1}>
          <Box gap={2}>
            <Text color="gray">{cap.timestamp.slice(0, 19)}</Text>
            <Text color={isAudio ? "magenta" : "cyan"} bold>{isAudio ? "♪ AUDIO" : "▣ SCREEN"}</Text>
          </Box>

          <Box marginTop={1}>
            <Text color="gray" bold>SOURCE  </Text>
            <Text color="white" bold>{cap.app}</Text>
            <Text color="gray"> · {cap.title}</Text>
          </Box>

          {cap.channels.length > 0 && (
            <Box marginTop={1} gap={1}>
              <Text color="gray" bold>CHANNELS</Text>
              {cap.channels.map(ch => (
                <Text key={ch} color="magenta"> {ch}</Text>
              ))}
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            <Text color="gray" bold>{isAudio ? "TRANSCRIPT" : "CAPTURED TEXT"}</Text>
            <Box marginTop={0} flexDirection="column">
              <Text color="white" wrap="wrap">{cap.fullText}</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  // --- Settings View ---
  if (view === "settings") {
    const tabs: { key: SettingsTab; label: string }[] = [
      { key: "general", label: "General" },
      { key: "channels", label: "Channels" },
    ];
    return (
      <Box flexDirection="column" paddingX={1} height={rows}>
        <Box paddingX={1} justifyContent="space-between">
          <Box gap={2}>
            <Text bold color="magenta">tunr</Text>
            <Text color="gray">Settings</Text>
          </Box>
          <Text color="gray">[Esc] back [Tab] tab</Text>
        </Box>
        <Box paddingX={1} gap={2}>
          {tabs.map(t => (
            <Text key={t.key} color={settingsTab === t.key ? "magenta" : "gray"} bold={settingsTab === t.key} underline={settingsTab === t.key}>
              {t.label}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" paddingX={1} marginTop={1} flexGrow={1}>
          {settingsTab === "general" && (
            <>
              <Text color="gray" bold dimColor>RECORDING</Text>
              <Box paddingLeft={1}>
                <Text color={settingsIndex === 0 ? "magenta" : "white"}>
                  {settingsIndex === 0 ? "▸" : " "} Screen interval: {screenIntervalSec}s  [[ ]] adjust
                </Text>
              </Box>
              <Box paddingLeft={1}>
                <Text color={settingsIndex === 1 ? "magenta" : "white"}>
                  {settingsIndex === 1 ? "▸" : " "} Change threshold: {changeThreshold.toFixed(2)}  [[ ]] adjust
                </Text>
              </Box>
              <Box paddingLeft={1}>
                <Text color={settingsIndex === 2 ? "magenta" : "white"}>
                  {settingsIndex === 2 ? "▸" : " "} Audio chunk: {audioChunkSec}s  [[ ]] adjust
                </Text>
              </Box>
              <Text color="gray" bold dimColor marginTop={1}>STORAGE</Text>
              <Box paddingLeft={1}>
                <Text color={settingsIndex === 3 ? "magenta" : "white"}>
                  {settingsIndex === 3 ? "▸" : " "} {deleteConfirm ? <Text color="red" bold>Press Enter to confirm DELETE ALL</Text> : "Delete all captures  [Enter]"}
                </Text>
              </Box>
              <Box paddingLeft={1} marginTop={1}>
                <Text color="gray">{recordCount} screen · {audioBroadcastCount} transcription · {dbSizeMB} MB</Text>
              </Box>
            </>
          )}
          {settingsTab === "channels" && (
            <>
              <Text color="gray" bold dimColor>CHANNELS  [C] create  [X] delete</Text>
              {channelCreateMode ? (
                <Box paddingLeft={1}>
                  <Text color="magenta">New: </Text>
                  <TextInput
                    value={newChannelName}
                    onChange={setNewChannelName}
                    onSubmit={(val: string) => {
                      const name = val.trim();
                      if (name) { try { db.run(`INSERT INTO channels (name) VALUES (?)`, name); } catch {} setChannels(getChannels()); }
                      setChannelCreateMode(false); setNewChannelName("");
                    }}
                  />
                </Box>
              ) : null}
              {channels.length === 0 ? (
                <Box paddingLeft={1}><Text color="gray">No channels. Press C to create.</Text></Box>
              ) : channels.map((ch, i) => {
                const sel = settingsIndex === i;
                const isSub = subscriptions.includes(ch.name);
                return (
                  <Box key={ch.id} paddingLeft={1} gap={1}>
                    <Text color={sel ? "magenta" : "white"}>{sel ? "▸" : " "}</Text>
                    <Text color="white" bold>{ch.name}</Text>
                    {isSub && <Text color="cyan">SUB</Text>}
                  </Box>
                );
              })}
            </>
          )}
        </Box>
      </Box>
    );
  }

  // --- Calendar View ---
  if (view === "calendar") {
    const weeks = Math.max(1, Math.ceil(calDays.length / 7));
    const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const maxCount = Math.max(1, ...calDays.map(d => d.total));

    const heatBg = (count: number, isCursor: boolean): string => {
      if (isCursor) return "magenta";
      if (count === 0) return "#555555";
      const level = Math.ceil((count / maxCount) * 4);
      return ["#0e4429", "#006d32", "#26a641", "#39d353"][Math.min(level - 1, 3)];
    };

    const cursorDayIdx = calCursorX * 7 + calCursorY;
    const cursorDay = cursorDayIdx < calDays.length ? calDays[cursorDayIdx] : null;

    // Month labels for the top
    const monthLabels: { week: number; label: string }[] = [];
    for (let w = 0; w < weeks; w++) {
      const idx = w * 7;
      if (idx < calDays.length) {
        const m = calDays[idx].date.slice(5, 7);
        const prev = w > 0 && (w - 1) * 7 < calDays.length ? calDays[(w - 1) * 7].date.slice(5, 7) : "";
        if (m !== prev) monthLabels.push({ week: w, label: calDays[idx].date.slice(0, 7) });
      }
    }

    if (calSelectedDate) {
      // Day detail view with hourly bar + capture list
      const calFeedH = Math.max(4, rows - 14);
      const visibleCals = calCaptures.slice(calFeedScroll, calFeedScroll + calFeedH);
      const maxHour = Math.max(1, ...calHourly.map(h => h.count));

      return (
        <Box flexDirection="column" paddingX={1} height={rows}>
          <Box paddingX={1} justifyContent="space-between">
            <Box gap={2}>
              <Text bold color="magenta">tunr</Text>
              <Text color="white" bold>{calSelectedDate}</Text>
              <Text color="gray">{calCaptures.length} captures</Text>
            </Box>
            <Text color="gray">[Esc] back</Text>
          </Box>

          <Box paddingX={1} marginTop={0}>
            {calHourly.map(h => {
              const barH = Math.max(0, Math.round((h.count / maxHour) * 4));
              const chars = ["_", ".", ":", "|", "#"];
              return (
                <Text key={h.hour} color={h.count > 0 ? "green" : "gray"} dimColor={h.count === 0}>
                  {chars[barH]}
                </Text>
              );
            })}
            <Text color="gray"> 0h          12h          23h</Text>
          </Box>

          <Box flexDirection="column" flexGrow={1} marginTop={1}>
            {visibleCals.length === 0 ? (
              <Box paddingX={2}><Text color="gray">No captures on this day.</Text></Box>
            ) : visibleCals.map((cap, i) => {
              const actualIdx = calFeedScroll + i;
              const sel = actualIdx === calFeedIndex;
              const time = cap.timestamp.slice(11, 19);
              const isAudio = cap.type === "audio";
              return (
                <Box key={cap.id} paddingLeft={1}>
                  <Text color={sel ? "magenta" : "gray"}>{sel ? "▸" : " "} </Text>
                  <Text color="gray" dimColor>{time} </Text>
                  <Text color={isAudio ? "magenta" : "cyan"}>{isAudio ? "♪" : "▣"} </Text>
                  <Text color="white" bold>{cap.app} </Text>
                  <Text color="gray" wrap="truncate-end">{cap.excerpt.slice(0, 60)} </Text>
                </Box>
              );
            })}
          </Box>
          <Box paddingX={1} justifyContent="space-between">
            <Text color="gray">[↑↓] scroll [Enter] detail [Esc] back</Text>
            {calCaptures.length > 0 && <Text color="gray">{calFeedIndex + 1}/{calCaptures.length}</Text>}
          </Box>
        </Box>
      );
    }

    // Heatmap grid view
    return (
      <Box flexDirection="column" paddingX={1} height={rows}>
        <Box paddingX={1} justifyContent="space-between">
          <Box gap={2}>
            <Text bold color="magenta">tunr</Text>
            <Text color="gray">Calendar</Text>
          </Box>
          <Text color="gray">[Esc] back [Enter] open day</Text>
        </Box>

        <Box flexDirection="column" paddingX={1} marginTop={1}>
          {/* Month labels */}
          <Box paddingLeft={5}>
            {Array.from({ length: weeks }, (_, w) => {
              const ml = monthLabels.find(m => m.week === w);
              return <Text key={w} color="gray">{ml ? ml.label.slice(5, 7) : "  "}</Text>;
            })}
          </Box>

          {/* Grid: 7 rows (days) x N cols (weeks) */}
          {dayLabels.map((label, dow) => (
            <Box key={dow}>
              <Text color="gray">{dow % 2 === 1 ? label : "   "} </Text>
              {Array.from({ length: weeks }, (_, w) => {
                const idx = w * 7 + dow;
                const day = idx < calDays.length ? calDays[idx] : null;
                const isCursor = w === calCursorX && dow === calCursorY;
                const count = day?.total || 0;
                return (
                  <Text key={w} backgroundColor={heatBg(count, isCursor)}>{"  "}</Text>
                );
              })}
            </Box>
          ))}
        </Box>

        {/* Cursor info */}
        <Box paddingX={1} marginTop={1} gap={2}>
          {cursorDay ? (
            <>
              <Text color="white" bold>{cursorDay.date}</Text>
              <Text color="gray">{cursorDay.screen} screen</Text>
              <Text color="gray">{cursorDay.audio} audio</Text>
              <Text color={cursorDay.total > 0 ? "green" : "gray"}>{cursorDay.total} total</Text>
            </>
          ) : <Text color="gray">--</Text>}
        </Box>

        <Box paddingX={1} marginTop={1}>
          <Text color="gray">[←→↑↓] navigate [Enter] open day [Esc] back</Text>
        </Box>
      </Box>
    );
  }

  // --- Feed View (default) ---
  return (
    <Box flexDirection="column" height={rows}>
      <Box borderStyle="round" borderColor="gray" marginX={1} marginBottom={0} flexDirection="column">
        <SourcesBar />
      </Box>
      <FilterBar />
      <Feed />
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text color="gray">
            {focusArea === "sources" ? "[Enter] assign [↑↓] nav [Tab] feed" : "[↑↓] scroll [Enter] detail [/] search"}
          </Text>
          <Text color="gray">[C]al [S]et [Q]uit</Text>
        </Box>
        <Box gap={1}>
          {updateAvailable && <Text color="yellow">v{updateAvailable} available</Text>}
          {captures.length > 0 && <Text color="gray">{feedIndex + 1}/{captures.length}</Text>}
        </Box>
      </Box>
    </Box>
  );
}

render(React.createElement(App));
