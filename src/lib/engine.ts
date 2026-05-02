import { join, dirname } from "path";
import { homedir } from "os";
import { readdirSync, statSync, unlinkSync } from "fs";

import type { DenyRule } from "./types";
import {
  AUDIO_DIR, MIC_DIR, AUDIO_SOURCE_KEY, MIC_SOURCE_KEY,
  POLL_MS, SETTINGS_PATH, savedSettings, savedAudioChunkSec,
} from "./constants";
import { db, insertStmt, insertAudioStmt } from "./db";
import { getChannels } from "./rules";
import { generateEmbedding, getAllWindows, windowKey } from "./capture";
import { isDenied } from "./deny";
import { computeDiffLines } from "./diff";
import { decideRecordAction, type WindowRecordState } from "./record-state";
import {
  upsertLiveSource, pruneStaleSources, ensureVirtualSources, listSources,
} from "./sources";

interface EngineSettings {
  screenIntervalSec: number;
  settleSec: number;
  audioChunkSec: number;
  denyList: DenyRule[];
}

function loadSettings(): EngineSettings {
  return {
    screenIntervalSec: typeof savedSettings.screenIntervalSec === "number" ? savedSettings.screenIntervalSec : 5,
    settleSec: typeof savedSettings.settleSec === "number" ? savedSettings.settleSec : 10,
    audioChunkSec: savedAudioChunkSec,
    denyList: Array.isArray(savedSettings.denyList) ? savedSettings.denyList : [],
  };
}

export interface EngineHandle {
  stop: () => void;
}

type Logger = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, any>) => void;

export function startEngine(log: Logger = defaultLog): EngineHandle {
  const settings = loadSettings();
  let active = true;

  cleanupAudioChunks(AUDIO_DIR, log);
  cleanupAudioChunks(MIC_DIR, log);

  // Reload settings.json on changes (single source of truth for runtime config)
  const reloadSettings = async () => {
    try {
      const f = Bun.file(SETTINGS_PATH);
      if (!(await f.exists())) return;
      const raw = JSON.parse(await f.text());
      if (typeof raw.screenIntervalSec === "number") settings.screenIntervalSec = raw.screenIntervalSec;
      if (typeof raw.settleSec === "number") settings.settleSec = raw.settleSec;
      if (typeof raw.audioChunkSec === "number") settings.audioChunkSec = raw.audioChunkSec;
      if (Array.isArray(raw.denyList)) settings.denyList = raw.denyList;
    } catch {}
  };
  const settingsTimer = setInterval(reloadSettings, 2000);

  const now0 = Date.now();
  ensureVirtualSources(now0);
  const virtualHeartbeat = setInterval(() => {
    const t = Date.now();
    ensureVirtualSources(t);
  }, 5000);

  // --- Window polling ---
  (async () => {
    while (active) {
      const found = await getAllWindows();
      const now = Date.now();
      for (const w of found) {
        upsertLiveSource(windowKey(w), w.app, w.title, w.urls ?? [], now);
      }
      pruneStaleSources(now);
      await Bun.sleep(POLL_MS);
    }
  })();

  // --- Recording ---
  (async () => {
    const windowState = new Map<string, WindowRecordState>();
    const lastRecordedTexts = new Map<string, string[]>();

    while (active) {
      await Bun.sleep(settings.screenIntervalSec * 1000);
      const found = await getAllWindows();
      const now = Date.now();
      const sources = listSources();
      const channelsByKey = new Map(sources.map(s => [s.window_key, s.channels]));

      for (const w of found) {
        if (!w.texts || w.texts.length === 0) continue;
        const key = windowKey(w);
        const channels = channelsByKey.get(key);
        if (!channels || channels.length === 0) continue;

        if (isDenied(settings.denyList, w.app, w.title, w.urls ?? [])) continue;

        const textsJson = JSON.stringify(w.texts);
        const state = windowState.get(key);
        const action = decideRecordAction(state, textsJson, now, settings.settleSec * 1000);

        if (action.kind === "skip") continue;
        if (action.kind === "update") {
          windowState.set(key, action.nextState);
          continue;
        }

        const fullText = w.texts.join("\n");
        const embedding = await generateEmbedding(fullText);
        const channelNamesJson = JSON.stringify(channels);
        const pageKey = `${w.window_id}\0${w.title}`;
        let diffText: string | null = null;
        let diffEmbedding: Buffer | null = null;
        if (action.kind === "commit") {
          const prev = lastRecordedTexts.get(pageKey);
          if (prev) {
            const diffLines = computeDiffLines(prev, w.texts);
            if (diffLines.length > 0) {
              diffText = diffLines.join("\n");
              diffEmbedding = await generateEmbedding(diffText);
            }
          }
        }
        lastRecordedTexts.set(pageKey, w.texts);
        insertStmt.run(
          new Date().toISOString(), w.pid, w.window_index, w.app, w.title,
          textsJson, embedding, channelNamesJson, w.window_id, diffText, diffEmbedding,
        );
        log("info", "screen", { app: w.app, title: w.title, channels });
        if (action.kind === "first") {
          windowState.set(key, { textsJson, lastChangeAt: now, recorded: true });
        } else {
          state!.recorded = true;
        }
      }
    }
  })();

  // --- Audio source/mic helpers ---
  const audioChannelsFor = (sourceKey: string) => {
    const r = db.prepare(`SELECT channels FROM sources WHERE window_key = ?`).get(sourceKey) as any;
    if (!r) return [];
    try { return JSON.parse(r.channels) as string[]; } catch { return []; }
  };
  const isAudioOn = () => audioChannelsFor(AUDIO_SOURCE_KEY).length > 0;
  const isMicOn = () => audioChannelsFor(MIC_SOURCE_KEY).length > 0;

  // Sync include_audio/include_mic flags on channels every few seconds
  const flagSync = setInterval(() => {
    const audioChans = audioChannelsFor(AUDIO_SOURCE_KEY);
    const micChans = audioChannelsFor(MIC_SOURCE_KEY);
    for (const ch of getChannels()) {
      const a = audioChans.includes(ch.name) ? 1 : 0;
      const m = micChans.includes(ch.name) ? 1 : 0;
      if (ch.include_audio !== a) db.run(`UPDATE channels SET include_audio = ? WHERE name = ?`, [a, ch.name]);
      if (ch.include_mic !== m) db.run(`UPDATE channels SET include_mic = ? WHERE name = ?`, [m, ch.name]);
    }
  }, 3000);

  // --- Audio loops ---
  const audioProcRef: { proc: any } = { proc: null };
  const micProcRef: { proc: any } = { proc: null };

  const startAudioLoop = (label: "system" | "mic", dir: string, isOn: () => boolean, procRef: { proc: any }) => {
    (async () => {
      const AUDIO_CAPTURE_PATH = join(dirname(process.execPath), "tunr-audio-capture");
      const AUDIO_CAPTURE_FALLBACK = join(import.meta.dir, "..", "..", "tunr-audio-capture");
      const audioBin = await Bun.file(AUDIO_CAPTURE_PATH).exists() ? AUDIO_CAPTURE_PATH : AUDIO_CAPTURE_FALLBACK;
      if (!await Bun.file(audioBin).exists()) { log("warn", `${label}: no binary`); return; }
      const whisperCheck = Bun.spawnSync(["which", "whisper-cli"], { stdout: "pipe", stderr: "pipe" });
      if (whisperCheck.exitCode !== 0) { log("warn", `${label}: whisper-cli not found`); return; }
      const modelPath = join(homedir(), ".cache", "whisper-cpp-small.bin");
      if (!await Bun.file(modelPath).exists()) { log("warn", `${label}: whisper model not found`); return; }

      while (active) {
        if (!isOn()) { await Bun.sleep(1000); continue; }
        const args = label === "mic"
          ? [audioBin, dir, String(settings.audioChunkSec), "--device", "default"]
          : [audioBin, dir, String(settings.audioChunkSec)];
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        procRef.proc = proc;
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (active && isOn()) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              if (!chunk || typeof chunk.file !== "string" || typeof chunk.timestamp !== "string") continue;
              const wp = Bun.spawnSync(["whisper-cli", "-m", modelPath, "-l", "auto", "-f", chunk.file, "-np", "-nt"], { stdout: "pipe", stderr: "pipe" });
              deleteAudioChunk(chunk.file, log);
              if (wp.exitCode !== 0) continue;
              const transcript = wp.stdout.toString().trim();
              if (transcript) {
                insertAudioStmt.run(chunk.timestamp, chunk.file, transcript, label);
                log("info", label, { excerpt: transcript.slice(0, 80) });
              }
            } catch {}
          }
        }
        proc.kill();
        procRef.proc = null;
      }
    })();
  };
  startAudioLoop("system", AUDIO_DIR, isAudioOn, audioProcRef);
  startAudioLoop("mic", MIC_DIR, isMicOn, micProcRef);

  return {
    stop() {
      active = false;
      clearInterval(settingsTimer);
      clearInterval(virtualHeartbeat);
      clearInterval(flagSync);
      try { audioProcRef.proc?.kill(); } catch {}
      try { micProcRef.proc?.kill(); } catch {}
    },
  };
}

function defaultLog(level: "info" | "warn" | "error", msg: string, extra?: Record<string, any>) {
  const ts = new Date().toISOString();
  const tag = level.toUpperCase();
  const e = extra ? " " + JSON.stringify(extra) : "";
  const line = `${ts} ${tag} ${msg}${e}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

function deleteAudioChunk(file: string, log: Logger) {
  try {
    unlinkSync(file);
  } catch (err: any) {
    if (err?.code !== "ENOENT") log("warn", "audio cleanup failed", { file, error: String(err) });
  }
}

function cleanupAudioChunks(dir: string, log: Logger) {
  try {
    for (const name of readdirSync(dir)) {
      if (name === ".keep") continue;
      const file = join(dir, name);
      try {
        if (statSync(file).isFile()) deleteAudioChunk(file, log);
      } catch (err: any) {
        if (err?.code !== "ENOENT") log("warn", "audio cleanup failed", { file, error: String(err) });
      }
    }
  } catch (err: any) {
    if (err?.code !== "ENOENT") log("warn", "audio cleanup failed", { dir, error: String(err) });
  }
}
