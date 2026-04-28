/**
 * CLI subcommands (non-TUI).
 */
import { db } from "./lib/db";
import { SETTINGS_PATH } from "./lib/constants";
import { listSources, assignSource, unassignSource } from "./lib/sources";
import { getChannels } from "./lib/rules";
import type { DenyRule } from "./lib/types";

// --- helpers ---

import { readFileSync, writeFileSync, existsSync } from "fs";

function loadSettingsRaw(): any {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    }
  } catch {}
  return {};
}

function saveSettingsRaw(s: any) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function setNested(obj: any, key: string, value: any) {
  const parts = key.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getNested(obj: any, key: string): any {
  const parts = key.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function unsetNested(obj: any, key: string) {
  const parts = key.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

function parseValue(s: string): any {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  try { return JSON.parse(s); } catch {}
  return s;
}

// --- sources ---

export function runSources(args: string[]) {
  const hasVerb = args[0] && !args[0].startsWith("--");
  const sub = hasVerb ? args[0] : "list";
  const rest = hasVerb ? args.slice(1) : args;

  if (sub === "list") {
    const json = rest.includes("--json");
    const rows = listSources();
    if (json) {
      console.log(JSON.stringify(rows));
      return;
    }
    for (const r of rows) {
      const ch = r.channels.length ? r.channels.join(",") : "-";
      const v = r.virtual ? "virtual" : "window";
      console.log(`${r.window_key}\t${r.app}\t${r.title}\t${ch}\t${v}`);
    }
    return;
  }

  if (sub === "assign" || sub === "unassign") {
    const [windowKey, channel] = rest;
    if (!windowKey || !channel) {
      console.error(`usage: tunr sources ${sub} <window-key> <channel>`);
      process.exit(1);
    }
    if (sub === "assign" && !getChannels().some(c => c.name === channel)) {
      console.error(`channel not found: ${channel}`);
      process.exit(1);
    }
    if (sub === "assign") assignSource(windowKey, channel);
    else unassignSource(windowKey, channel);
    console.log(`${sub === "assign" ? "assigned" : "unassigned"} ${windowKey} -> ${channel}`);
    return;
  }

  console.error(`unknown subcommand: ${sub}`);
  process.exit(1);
}

// --- channels ---

export function runChannels(args: string[]) {
  const sub = args[0];
  if (!sub || sub === "list") {
    for (const ch of getChannels()) {
      const flags = [
        ch.include_audio ? "audio" : null,
        ch.include_mic ? "mic" : null,
      ].filter(Boolean).join(",") || "-";
      console.log(`${ch.id}\t${ch.name}\t${flags}`);
    }
    return;
  }
  if (sub === "add") {
    const name = args[1]?.trim();
    if (!name) { console.error("usage: tunr channels add <name>"); process.exit(1); }
    const safe = name.replace(/[^a-zA-Z0-9_\-]/g, "").slice(0, 32);
    if (!safe) { console.error("invalid channel name"); process.exit(1); }
    try { db.run(`INSERT INTO channels (name) VALUES (?)`, [safe]); }
    catch (e: any) { console.error(`failed: ${e.message}`); process.exit(1); }
    console.log(`added: ${safe}`);
    return;
  }
  if (sub === "rm") {
    const name = args[1]?.trim();
    if (!name) { console.error("usage: tunr channels rm <name>"); process.exit(1); }
    db.run(`DELETE FROM channels WHERE name = ?`, [name]);
    console.log(`removed: ${name}`);
    return;
  }
  console.error(`unknown subcommand: ${sub}`);
  process.exit(1);
}

// --- deny ---

export function runDeny(args: string[]) {
  const sub = args[0] ?? "list";
  const settings = loadSettingsRaw();
  const denyList: DenyRule[] = Array.isArray(settings.denyList) ? settings.denyList : [];

  if (sub === "list") {
    denyList.forEach((rule, i) => {
      const parts = [
        rule.app && `app=${rule.app}`,
        rule.title && `title=${rule.title}`,
        rule.url && `url=${rule.url}`,
      ].filter(Boolean).join(" ");
      console.log(`${i}\t${parts}`);
    });
    return;
  }
  if (sub === "add") {
    const rule: DenyRule = {};
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--app") rule.app = args[++i];
      else if (arg === "--title") rule.title = args[++i];
      else if (arg === "--url") rule.url = args[++i];
    }
    if (!rule.app && !rule.title && !rule.url) {
      console.error("usage: tunr deny add [--app <glob>] [--title <glob>] [--url <glob>]");
      process.exit(1);
    }
    denyList.push(rule);
    settings.denyList = denyList;
    saveSettingsRaw(settings);
    console.log(`added rule #${denyList.length - 1}`);
    return;
  }
  if (sub === "rm") {
    const idx = parseInt(args[1] ?? "", 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= denyList.length) {
      console.error("usage: tunr deny rm <index>");
      process.exit(1);
    }
    denyList.splice(idx, 1);
    settings.denyList = denyList;
    saveSettingsRaw(settings);
    console.log(`removed rule #${idx}`);
    return;
  }
  console.error(`unknown subcommand: ${sub}`);
  process.exit(1);
}

// --- log ---

export async function runLog(args: string[]) {
  const limit = 50;
  const screenStmt = db.prepare(
    `SELECT id, timestamp, app, window_title, texts, channel_names FROM screen_states ORDER BY id DESC LIMIT ?`,
  );
  const audioStmt = db.prepare(
    `SELECT id, timestamp, transcript, source FROM audio_transcripts ORDER BY id DESC LIMIT ?`,
  );

  const initialScreen = (screenStmt.all(limit) as any[]).reverse();
  const initialAudio = (audioStmt.all(limit) as any[]).reverse();

  let lastScreenId = 0;
  let lastAudioId = 0;
  for (const r of initialScreen) {
    printScreenRow(r);
    if (r.id > lastScreenId) lastScreenId = r.id;
  }
  for (const r of initialAudio) {
    printAudioRow(r);
    if (r.id > lastAudioId) lastAudioId = r.id;
  }

  if (!args.includes("--follow") && !args.includes("-f")) return;

  const screenSince = db.prepare(
    `SELECT id, timestamp, app, window_title, texts, channel_names FROM screen_states WHERE id > ? ORDER BY id`,
  );
  const audioSince = db.prepare(
    `SELECT id, timestamp, transcript, source FROM audio_transcripts WHERE id > ? ORDER BY id`,
  );

  while (true) {
    const newScreen = screenSince.all(lastScreenId) as any[];
    for (const r of newScreen) { printScreenRow(r); lastScreenId = r.id; }
    const newAudio = audioSince.all(lastAudioId) as any[];
    for (const r of newAudio) { printAudioRow(r); lastAudioId = r.id; }
    await Bun.sleep(1000);
  }
}

function printScreenRow(r: any) {
  let texts: string[] = [];
  try { texts = JSON.parse(r.texts); } catch {}
  let channels: string[] = [];
  try { channels = JSON.parse(r.channel_names ?? "[]"); } catch {}
  const ch = channels.length ? channels.join(",") : "-";
  const excerpt = texts.join(" ").slice(0, 80).replace(/\s+/g, " ");
  console.log(`${r.timestamp}\tscreen\t${ch}\t${r.app}\t${excerpt}`);
}

function printAudioRow(r: any) {
  const excerpt = r.transcript.slice(0, 80).replace(/\s+/g, " ");
  console.log(`${r.timestamp}\taudio:${r.source}\t-\t-\t${excerpt}`);
}

// --- config ---

export function runConfig(args: string[]) {
  const sub = args[0];
  const settings = loadSettingsRaw();
  if (sub === "get") {
    const key = args[1];
    if (!key) {
      console.log(JSON.stringify(settings, null, 2));
      return;
    }
    const v = getNested(settings, key);
    if (v === undefined) process.exit(1);
    console.log(typeof v === "string" ? v : JSON.stringify(v));
    return;
  }
  if (sub === "set") {
    const key = args[1];
    const value = args.slice(2).join(" ");
    if (!key || value === "") { console.error("usage: tunr config set <key> <value>"); process.exit(1); }
    setNested(settings, key, parseValue(value));
    saveSettingsRaw(settings);
    return;
  }
  if (sub === "unset") {
    const key = args[1];
    if (!key) { console.error("usage: tunr config unset <key>"); process.exit(1); }
    unsetNested(settings, key);
    saveSettingsRaw(settings);
    return;
  }
  console.error(`usage: tunr config <get|set|unset> <key> [value]`);
  process.exit(1);
}
