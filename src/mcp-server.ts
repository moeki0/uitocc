#!/usr/bin/env bun
/**
 * tunr MCP server — Provides screen context to Claude Code via channels
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync } from "fs";

const DATA_DIR = join(homedir(), "Library", "Application Support", "tunr");
const DB_PATH = join(DATA_DIR, "tunr.db");

function openDb(): Database | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH, { readonly: true });
    return db;
  } catch {
    return null;
  }
}

function openDbWritable(): Database | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH);
    db.run("PRAGMA busy_timeout=5000");
    db.run("PRAGMA journal_mode=WAL");
    return db;
  } catch {
    return null;
  }
}

// --- Embedding helpers ---
const EMBED_PATH = join(dirname(process.execPath), "tunr-embed");
const EMBED_FALLBACK = join(import.meta.dir, "..", "tunr-embed");
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

const mcp = new Server(
  { name: "tunr", version: "1.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "tunr events arrive as <channel source=\"tunr\" ...>.",
      "event=user_send: User pressed shortcut to share current screen.",
      "event=screen: Real-time screen content changes for a subscribed channel.",
      "event=audio: Real-time audio transcription for a subscribed channel.",
      "Use list_channels to see available channels, then subscribe to receive notifications.",
      "Use the search_screen_history and recent_screens tools to look up what the user has been doing on screen.",
      "Proactively use these tools when the user references something they were looking at, or when screen context would help.",
    ].join(" "),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_channels",
      description:
        "List available tunr channels and their subscription status. Channels group windows and optionally audio.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "subscribe",
      description:
        "Subscribe to a tunr channel to receive real-time screen and audio notifications.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description: "Channel name to subscribe to",
          },
        },
        required: ["channel"],
      },
    },
    {
      name: "unsubscribe",
      description:
        "Unsubscribe from a tunr channel to stop receiving notifications.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description: "Channel name to unsubscribe from",
          },
        },
        required: ["channel"],
      },
    },
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
          channel: {
            type: "string",
            description: "Filter results to a specific channel",
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
          channel: {
            type: "string",
            description: "Filter results to a specific channel",
          },
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
        "Get recent audio transcripts from system audio captured by the daemon.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description: "Filter results to a specific channel (only channels with audio enabled)",
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
      name: "search_audio",
      description:
        "Search audio transcripts from system audio captured by the daemon.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query to find in audio transcripts",
          },
          channel: {
            type: "string",
            description: "Filter results to a specific channel (only channels with audio enabled)",
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
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "list_channels") {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: `No channels available. DB_PATH=${DB_PATH} exists=${existsSync(DB_PATH)}` }] };
    }
    try {
      const channels = db.prepare(
        `SELECT c.name, c.include_audio,
                EXISTS(SELECT 1 FROM channel_subscriptions cs WHERE cs.channel_name = c.name) as subscribed
         FROM channels c ORDER BY c.id`
      ).all() as any[];

      if (channels.length === 0) {
        return { content: [{ type: "text" as const, text: "No channels configured. Create channels in the tunr TUI (tunr start)." }] };
      }

      const lines = channels.map((ch) => {
        return `${ch.subscribed ? "●" : "○"} ${ch.name} [audio: ${ch.include_audio ? "on" : "off"}]${ch.subscribed ? " (subscribed)" : ""}`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } finally {
      db.close();
    }
  }

  if (name === "subscribe") {
    const channel = (args as any).channel as string;
    const db = openDbWritable();
    if (!db) {
      return { content: [{ type: "text" as const, text: "Database not available. Is the watch daemon running?" }] };
    }
    try {
      const exists = db.prepare(`SELECT 1 FROM channels WHERE name = ?`).get(channel);
      if (!exists) {
        const available = db.prepare(`SELECT name FROM channels ORDER BY id`).all() as any[];
        return { content: [{ type: "text" as const, text: `Channel "${channel}" does not exist. Available: ${available.map(c => c.name).join(", ") || "(none)"}` }] };
      }
      db.run(`INSERT OR REPLACE INTO channel_subscriptions (channel_name) VALUES (?)`, channel);
      return { content: [{ type: "text" as const, text: `Subscribed to channel "${channel}". You will receive screen${db.prepare(`SELECT include_audio FROM channels WHERE name = ?`).get(channel)?.include_audio ? " and audio" : ""} notifications.` }] };
    } finally {
      db.close();
    }
  }

  if (name === "unsubscribe") {
    const channel = (args as any).channel as string;
    const db = openDbWritable();
    if (!db) {
      return { content: [{ type: "text" as const, text: "Database not available." }] };
    }
    try {
      db.run(`DELETE FROM channel_subscriptions WHERE channel_name = ?`, channel);
      return { content: [{ type: "text" as const, text: `Unsubscribed from channel "${channel}".` }] };
    } finally {
      db.close();
    }
  }

  if (name === "search_screen_history") {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: "No screen history available. Is the watch daemon running?" }] };
    }
    try {
      const query = (args as any).query as string;
      const channelFilter = (args as any).channel as string | undefined;
      const appFilter = (args as any).app as string | undefined;
      const minutes = ((args as any).minutes as number) || 60;
      const limit = ((args as any).limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();
      const appClause = appFilter ? ` AND (app LIKE '%${appFilter.replace(/'/g, "''")}%' OR window_title LIKE '%${appFilter.replace(/'/g, "''")}%')` : "";
      const channelClause = channelFilter ? ` AND channel_names LIKE '%${channelFilter.replace(/'/g, "''")}%'` : "";

      // Try vector search first
      const queryVec = queryEmbedding(query);
      if (queryVec) {
        const rows = db.prepare(
          `SELECT timestamp, app, window_title, texts, embedding, channel_names FROM screen_states
           WHERE timestamp > ? AND embedding IS NOT NULL${appClause}${channelClause}
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
            const ch = r.channel_names ? ` [${r.channel_names}]` : "";
            return `[${r.timestamp}] ${r.app} — ${r.window_title}${ch} (similarity: ${r.score.toFixed(3)})\n${texts.join("\n")}`;
          }).join("\n\n---\n\n");

          return { content: [{ type: "text" as const, text: result }] };
        }
      }

      // Fallback to LIKE search
      const rows = db.prepare(
        `SELECT timestamp, app, window_title, texts, channel_names FROM screen_states
         WHERE timestamp > ? AND (app LIKE ? OR window_title LIKE ? OR texts LIKE ?)${appClause}${channelClause}
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, `%${query}%`, `%${query}%`, `%${query}%`, limit) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No screen history matching "${query}" in the last ${minutes} minutes.` }] };
      }

      const result = rows.map((r) => {
        const texts = JSON.parse(r.texts) as string[];
        const ch = r.channel_names ? ` [${r.channel_names}]` : "";
        return `[${r.timestamp}] ${r.app} — ${r.window_title}${ch}\n${texts.join("\n")}`;
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
      const channelFilter = (args as any)?.channel as string | undefined;
      const appFilter = (args as any)?.app as string | undefined;
      const minutes = ((args as any)?.minutes as number) || 10;
      const limit = ((args as any)?.limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();
      const appClause = appFilter ? ` AND (app LIKE '%${appFilter.replace(/'/g, "''")}%' OR window_title LIKE '%${appFilter.replace(/'/g, "''")}%')` : "";
      const channelClause = channelFilter ? ` AND channel_names LIKE '%${channelFilter.replace(/'/g, "''")}%'` : "";

      const rows = db.prepare(
        `SELECT timestamp, app, window_title, texts, channel_names FROM screen_states
         WHERE timestamp > ?${appClause}${channelClause}
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, limit) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No screen history in the last ${minutes} minutes.` }] };
      }

      const content: any[] = [];
      for (const r of rows) {
        const texts = JSON.parse(r.texts) as string[];
        const ch = r.channel_names ? ` [${r.channel_names}]` : "";
        content.push({ type: "text" as const, text: `[${r.timestamp}] ${r.app} — ${r.window_title}${ch}\n${texts.join("\n")}` });
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

  return { content: [{ type: "text" as const, text: "Unknown tool" }] };
});

// Poll DB for new screen/audio records and notify subscribed channels
let lastScreenId = 0;
let lastAudioId = 0;

async function pollDb() {
  // Initialize cursors to latest IDs
  const initDb = openDb();
  if (initDb) {
    try {
      const s = initDb.prepare("SELECT MAX(id) as m FROM screen_states").get() as any;
      const a = initDb.prepare("SELECT MAX(id) as m FROM audio_transcripts").get() as any;
      lastScreenId = s?.m || 0;
      lastAudioId = a?.m || 0;
    } finally {
      initDb.close();
    }
  }

  while (true) {
    await Bun.sleep(2000);

    const db = openDb();
    if (!db) continue;
    try {
      // Get subscribed channels
      const subs = db.prepare("SELECT channel_name FROM channel_subscriptions").all() as any[];
      if (subs.length === 0) continue;
      const subNames = subs.map((s: any) => s.channel_name);

      // New screen records
      const screens = db.prepare(
        "SELECT id, timestamp, app, window_title, texts, channel_names FROM screen_states WHERE id > ? ORDER BY id"
      ).all(lastScreenId) as any[];

      for (const r of screens) {
        lastScreenId = r.id;
        const chans: string[] = r.channel_names ? JSON.parse(r.channel_names) : [];
        const matched = chans.filter(ch => subNames.includes(ch));
        if (matched.length === 0) continue;

        const texts = JSON.parse(r.texts) as string[];
        const content = `**${r.app}** — "${r.window_title}"\n${texts.join("\n")}`;

        for (const ch of matched) {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: `[${ch}] Screen update:\n\n${content}`,
              meta: { source: "tunr", event: "screen", channel: ch, timestamp: r.timestamp },
            },
          });
        }
      }

      // New audio records
      const audios = db.prepare(
        "SELECT id, timestamp, transcript FROM audio_transcripts WHERE id > ? ORDER BY id"
      ).all(lastAudioId) as any[];

      // Find channels with audio enabled
      const audioChans = db.prepare("SELECT name FROM channels WHERE include_audio = 1").all() as any[];
      const audioSubbed = audioChans.map((c: any) => c.name).filter((n: string) => subNames.includes(n));

      for (const r of audios) {
        lastAudioId = r.id;
        if (audioSubbed.length === 0) continue;

        for (const ch of audioSubbed) {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: `[${ch}] Audio transcript:\n${r.transcript}`,
              meta: { source: "tunr", event: "audio", channel: ch, timestamp: r.timestamp },
            },
          });
        }
      }
    } finally {
      db.close();
    }
  }
}

await mcp.connect(new StdioServerTransport());
pollDb();
