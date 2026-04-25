#!/usr/bin/env bun
/**
 * tunr MCP server — Provides screen context to Claude Code
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync, unlinkSync } from "fs";

const DATA_DIR = join(homedir(), "Library", "Application Support", "tunr");
const CHANNEL_EVENT_PATH = join(DATA_DIR, "channel_event.json");
const CHANNEL_TV_EVENT_PATH = join(DATA_DIR, "channel_tv_event.json");
const CHANNEL_RADIO_EVENT_PATH = join(DATA_DIR, "channel_audio_event.json");
const CHANNEL_STATUS_PATH = join(DATA_DIR, "channel_status.json");
const DB_PATH = join(DATA_DIR, "tunr.db");

function openDb(): Database | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH, { readonly: true });
    db.run("PRAGMA journal_mode=WAL");
    return db;
  } catch {
    return null;
  }
}

// --- Embedding helpers ---
const EMBED_PATH = join(dirname(process.execPath), "tunr-embed");
const EMBED_FALLBACK = join(import.meta.dir, "tunr-embed");
const embedBin = existsSync(EMBED_PATH) ? EMBED_PATH : EMBED_FALLBACK;

function queryEmbedding(text: string): Float64Array | null {
  try {
    const proc = Bun.spawnSync([embedBin], {
      stdin: new TextEncoder().encode(text),
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const vec: number[] = JSON.parse(proc.stdout.toString().trim());
    return new Float64Array(vec);
  } catch {
    return null;
  }
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function blobToFloat64Array(blob: Uint8Array | Buffer): Float64Array {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const arr = new Float64Array(blob.byteLength / 8);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = view.getFloat64(i * 8, false); // big-endian
  }
  return arr;
}

let tvChannelEnabled = false;
let radioChannelEnabled = false;

async function syncChannelStatus() {
  try {
    await Bun.write(CHANNEL_STATUS_PATH, JSON.stringify({ tv: tvChannelEnabled, radio: radioChannelEnabled }));
  } catch {}
}

const mcp = new Server(
  { name: "tunr", version: "0.6.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "tunr events arrive as <channel source=\"tunr\" ...>.",
      "event=user_send: User pressed shortcut to share current screen.",
      "event=tv: Real-time screen content changes (enable with toggle_tv).",
      "event=radio: Real-time audio transcription (enable with toggle_radio).",
      "Use the search_screen_history and recent_screens tools to look up what the user has been doing on screen.",
      "Proactively use these tools when the user references something they were looking at, or when screen context would help.",
    ].join(" "),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_screen_history",
      description:
        "Search the user's screen history for text content. Returns matching screen states from the observation daemon.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Text to search for in screen content (app name, window title, or visible text)",
          },
          app: {
            type: "string",
            description: "Filter by app name or window title (partial match)",
          },
          minutes: {
            type: "number",
            description: "Only search within the last N minutes (default: 60)",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 20)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "recent_screens",
      description:
        "Get the most recent screen states observed by the daemon. Shows what the user has been looking at recently.",
      inputSchema: {
        type: "object" as const,
        properties: {
          app: {
            type: "string",
            description: "Filter by app name or window title (partial match)",
          },
          minutes: {
            type: "number",
            description: "How far back to look in minutes (default: 10)",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 20)",
          },
        },
      },
    },
    {
      name: "recent_audio",
      description:
        "Get recent audio transcripts from system audio captured by the daemon. Shows what the user has been listening to.",
      inputSchema: {
        type: "object" as const,
        properties: {
          minutes: {
            type: "number",
            description: "How far back to look in minutes (default: 10)",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 20)",
          },
        },
      },
    },
    {
      name: "search_audio",
      description:
        "Search audio transcripts from system audio captured by the daemon. Useful for finding what was said in videos, meetings, or any audio the user was listening to.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query to find in audio transcripts",
          },
          minutes: {
            type: "number",
            description: "Only search within the last N minutes (default: 60)",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 20)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "toggle_tv",
      description:
        "Enable or disable real-time screen change channel notifications (TV). When enabled, screen content changes are pushed via channel events as they happen.",
      inputSchema: {
        type: "object" as const,
        properties: {
          enabled: {
            type: "boolean",
            description: "true to enable, false to disable TV channel",
          },
        },
        required: ["enabled"],
      },
    },
    {
      name: "toggle_radio",
      description:
        "Enable or disable real-time audio transcript channel notifications (RADIO). When enabled, transcriptions are pushed every ~10 seconds via channel events.",
      inputSchema: {
        type: "object" as const,
        properties: {
          enabled: {
            type: "boolean",
            description: "true to enable, false to disable RADIO channel",
          },
        },
        required: ["enabled"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "search_screen_history") {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: "No screen history available. Is the watch daemon running?" }] };
    }
    try {
      const query = (args as any).query as string;
      const appFilter = (args as any).app as string | undefined;
      const minutes = ((args as any).minutes as number) || 60;
      const limit = ((args as any).limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();
      const appClause = appFilter ? ` AND (app LIKE '%${appFilter.replace(/'/g, "''")}%' OR window_title LIKE '%${appFilter.replace(/'/g, "''")}%')` : "";

      // Try vector search first
      const queryVec = queryEmbedding(query);
      if (queryVec) {
        const rows = db.prepare(
          `SELECT timestamp, app, window_title, texts, embedding FROM screen_states
           WHERE timestamp > ? AND embedding IS NOT NULL${appClause}
           ORDER BY timestamp DESC LIMIT 200`
        ).all(since) as any[];

        if (rows.length > 0) {
          const scored = rows.map((r) => {
            const emb = blobToFloat64Array(r.embedding);
            const score = cosineSimilarity(queryVec, emb);
            return { ...r, score };
          }).sort((a, b) => b.score - a.score).slice(0, limit);

          const result = scored.map((r) => {
            const texts = JSON.parse(r.texts) as string[];
            return `[${r.timestamp}] ${r.app} — ${r.window_title} (similarity: ${r.score.toFixed(3)})\n${texts.join("\n")}`;
          }).join("\n\n---\n\n");

          return { content: [{ type: "text" as const, text: result }] };
        }
      }

      // Fallback to LIKE search
      const rows = db.prepare(
        `SELECT timestamp, app, window_title, texts FROM screen_states
         WHERE timestamp > ? AND (app LIKE ? OR window_title LIKE ? OR texts LIKE ?)${appClause}
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, `%${query}%`, `%${query}%`, `%${query}%`, limit) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No screen history matching "${query}" in the last ${minutes} minutes.` }] };
      }

      const result = rows.map((r) => {
        const texts = JSON.parse(r.texts) as string[];
        return `[${r.timestamp}] ${r.app} — ${r.window_title}\n${texts.join("\n")}`;
      }).join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: result }] };
    } finally {
      db.close();
    }
  }

  if (name === "recent_screens") {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: "No screen history available. Is the watch daemon running?" }] };
    }
    try {
      const appFilter = (args as any)?.app as string | undefined;
      const minutes = ((args as any)?.minutes as number) || 10;
      const limit = ((args as any)?.limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();
      const appClause = appFilter ? ` AND (app LIKE '%${appFilter.replace(/'/g, "''")}%' OR window_title LIKE '%${appFilter.replace(/'/g, "''")}%')` : "";

      const rows = db.prepare(
        `SELECT timestamp, app, window_title, texts, screenshot_path FROM screen_states
         WHERE timestamp > ?${appClause}
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, limit) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No screen history in the last ${minutes} minutes.` }] };
      }

      const content: any[] = [];
      for (const r of rows) {
        const texts = JSON.parse(r.texts) as string[];
        content.push({ type: "text" as const, text: `[${r.timestamp}] ${r.app} — ${r.window_title}\n${texts.join("\n")}` });
      }

      return { content };
    } finally {
      db.close();
    }
  }

  if (name === "recent_audio") {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: "No audio history available. Is the watch daemon running?" }] };
    }
    try {
      const minutes = ((args as any)?.minutes as number) || 10;
      const limit = ((args as any)?.limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();

      const rows = db.prepare(
        `SELECT timestamp, transcript FROM audio_transcripts
         WHERE timestamp > ?
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, limit) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No audio transcripts in the last ${minutes} minutes.` }] };
      }

      const result = rows.map((r) =>
        `[${r.timestamp}] ${r.transcript}`
      ).join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: result }] };
    } finally {
      db.close();
    }
  }

  if (name === "search_audio") {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: "No audio history available. Is the watch daemon running?" }] };
    }
    try {
      const query = (args as any).query as string;
      const minutes = ((args as any).minutes as number) || 60;
      const limit = ((args as any).limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();

      const rows = db.prepare(
        `SELECT timestamp, transcript FROM audio_transcripts
         WHERE timestamp > ? AND transcript LIKE ?
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, `%${query}%`, limit) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No audio transcripts matching "${query}" in the last ${minutes} minutes.` }] };
      }

      const result = rows.map((r) =>
        `[${r.timestamp}] ${r.transcript}`
      ).join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: result }] };
    } finally {
      db.close();
    }
  }

  if (name === "toggle_tv") {
    const enabled = (args as any).enabled as boolean;
    tvChannelEnabled = enabled;
    await syncChannelStatus();
    return { content: [{ type: "text" as const, text: `TV channel ${enabled ? "ON" : "OFF"}.` }] };
  }

  if (name === "toggle_radio") {
    const enabled = (args as any).enabled as boolean;
    radioChannelEnabled = enabled;
    await syncChannelStatus();
    return { content: [{ type: "text" as const, text: `RADIO channel ${enabled ? "ON" : "OFF"}.` }] };
  }

  return { content: [{ type: "text" as const, text: "Unknown tool" }] };
});

async function pollChannelEvents() {
  while (true) {
    await Bun.sleep(1000);

    // Sync channel status from TUI
    if (existsSync(CHANNEL_STATUS_PATH)) {
      try {
        const data = JSON.parse(await Bun.file(CHANNEL_STATUS_PATH).text());
        if (data.tv !== undefined) tvChannelEnabled = data.tv;
        if (data.radio !== undefined) radioChannelEnabled = data.radio;
      } catch {}
    }

    // Check for screen events
    if (existsSync(CHANNEL_EVENT_PATH)) {
      try {
        const raw = await Bun.file(CHANNEL_EVENT_PATH).text();
        unlinkSync(CHANNEL_EVENT_PATH);
        const event = JSON.parse(raw);

        let content = `User is looking at: **${event.app}** — "${event.windowTitle}"`;
        if (event.cursorText) content += `\n\nText at cursor:\n${event.cursorText}`;
        if (event.contextTexts?.length > 0) {
          content += `\n\nVisible text:\n${event.contextTexts.map((t: string) => `- ${t}`).join("\n")}`;
        }

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content,
            meta: {
              source: "tunr",
              event: "user_send",
              app: event.app,
              windowTitle: event.windowTitle,
            },
          },
        });
      } catch {}
    }

    // Check for TV events
    if (tvChannelEnabled && existsSync(CHANNEL_TV_EVENT_PATH)) {
      try {
        const raw = await Bun.file(CHANNEL_TV_EVENT_PATH).text();
        unlinkSync(CHANNEL_TV_EVENT_PATH);
        const event = JSON.parse(raw);

        if (event.entries) {
          const lines = event.entries.map((s: any) => {
            let line = `**${s.app}** — "${s.windowTitle}"`;
            if (s.texts?.length) line += `\n${s.texts.join("\n")}`;
            return line;
          });
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: `Screen update:\n\n${lines.join("\n\n")}`,
              meta: {
                source: "tunr",
                event: "tv",
                timestamp: event.timestamp,
              },
            },
          });
        } else {
          // Legacy single-window format
          let textContent = `Screen: **${event.app}** — "${event.windowTitle}"`;
          if (event.screenshotPath) textContent += `\nScreenshot: ${event.screenshotPath}`;
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: textContent,
              meta: { source: "tunr", event: "tv", app: event.app, windowTitle: event.windowTitle },
            },
          });
        }
      } catch {}
    }

    // Check for RADIO events
    if (radioChannelEnabled && existsSync(CHANNEL_RADIO_EVENT_PATH)) {
      try {
        const raw = await Bun.file(CHANNEL_RADIO_EVENT_PATH).text();
        unlinkSync(CHANNEL_RADIO_EVENT_PATH);
        const event = JSON.parse(raw);

        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: `Audio transcript:\n${event.transcript}`,
            meta: {
              source: "tunr",
              event: "radio",
              timestamp: event.timestamp,
            },
          },
        });
      } catch {}
    }
  }
}

await mcp.connect(new StdioServerTransport());
pollChannelEvents();
