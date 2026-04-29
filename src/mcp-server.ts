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

// Ensure ingested table exists (may not exist if tunr ingest was never run)
try {
  if (existsSync(DB_PATH)) {
    const initDb = new Database(DB_PATH);
    initDb.run(`CREATE TABLE IF NOT EXISTS ingested (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      channel_name TEXT,
      text TEXT NOT NULL,
      meta TEXT,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    initDb.close();
  }
} catch {}

function openDb(): Database | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const db = new Database(DB_PATH, { readonly: true });
    return db;
  } catch {
    return null;
  }
}

// Resolve a time range from {from, to, minutes}. `from`/`to` accept ISO strings or YYYY-MM-DD.
// When `from` is given it overrides `minutes`. When `to` is given without `from`, the window
// is `[to - minutes, to]` so a past `to` doesn't collapse to zero results.
function resolveRange(args: any, defaultMinutes: number): { fromIso: string; toIso: string | null; label: string } {
  const fromArg = args?.from as string | undefined;
  const toArg = args?.to as string | undefined;
  const minutesRaw = args?.minutes as number | undefined;
  const minutes = (typeof minutesRaw === "number" && minutesRaw > 0) ? minutesRaw : defaultMinutes;
  const norm = (s: string, kind: "from" | "to"): Date => {
    const endOfDay = kind === "to";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return new Date(s + (endOfDay ? "T23:59:59.999" : "T00:00:00"));
    }
    return new Date(s);
  };
  const fromDate = fromArg ? norm(fromArg, "from") : null;
  const toDate = toArg ? norm(toArg, "to") : null;
  if (fromDate && isNaN(fromDate.getTime())) throw new Error(`Invalid \`from\`: ${fromArg}`);
  if (toDate && isNaN(toDate.getTime())) throw new Error(`Invalid \`to\`: ${toArg}`);
  const toIso = toDate ? toDate.toISOString() : null;
  const fromIso = fromDate
    ? fromDate.toISOString()
    : toDate
      ? new Date(toDate.getTime() - minutes * 60_000).toISOString()
      : new Date(Date.now() - minutes * 60_000).toISOString();
  const label = fromArg
    ? (toArg ? `${fromArg}..${toArg}` : `since ${fromArg}`)
    : (toArg ? `${minutes} minutes before ${toArg}` : `last ${minutes} minutes`);
  return { fromIso, toIso, label };
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

import { cosineSimilarity, blobToFloat64Array } from "./lib/embedding";
import { makeDiff } from "./lib/unified-diff";

function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzMin);
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
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
        "Search the user's screen and ingested history for text content. Returns matching screen states and ingested records.",
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
            description: "Only search within the last N minutes (default: 60). Ignored if `from` is set.",
          },
          from: {
            type: "string",
            description: "Start of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is interpreted as local-time start-of-day). Overrides `minutes`. When using a wide range, raise `limit` to avoid being capped.",
          },
          to: {
            type: "string",
            description: "End of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is end-of-day local). Optional upper bound. If `to` is given without `from`, the window is `minutes` wide ending at `to`.",
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
        "Get the most recent screen states and ingested records. Shows what the user has been looking at and data piped via tunr ingest.",
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
            description: "How far back to look in minutes (default: 10). Ignored if `from` is set.",
          },
          from: {
            type: "string",
            description: "Start of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is interpreted as local-time start-of-day). Overrides `minutes`. When using a wide range, raise `limit` to avoid being capped.",
          },
          to: {
            type: "string",
            description: "End of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is end-of-day local). Optional upper bound. If `to` is given without `from`, the window is `minutes` wide ending at `to`.",
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
        "Get recent audio transcripts captured by the daemon.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description: "Filter results to a specific channel (only channels with audio enabled)",
          },
          source: {
            type: "string",
            enum: ["system", "mic"],
            description: "Filter by audio source: 'system' (app/speaker audio via BlackHole) or 'mic' (microphone). Omit for both.",
          },
          minutes: {
            type: "number",
            description: "How far back to look in minutes (default: 10). Ignored if `from` is set.",
          },
          from: {
            type: "string",
            description: "Start of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is interpreted as local-time start-of-day). Overrides `minutes`. When using a wide range, raise `limit` to avoid being capped.",
          },
          to: {
            type: "string",
            description: "End of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is end-of-day local). Optional upper bound. If `to` is given without `from`, the window is `minutes` wide ending at `to`.",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 20)",
          },
        },
      },
    },
    {
      name: "pause",
      description:
        "Pause all tunr channel subscriptions. Notifications stop but subscriptions are remembered for resume.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "resume",
      description:
        "Resume all paused tunr channel subscriptions.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "search_audio",
      description:
        "Search audio transcripts captured by the daemon.",
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
          source: {
            type: "string",
            enum: ["system", "mic"],
            description: "Filter by audio source: 'system' (app/speaker audio via BlackHole) or 'mic' (microphone). Omit for both.",
          },
          minutes: {
            type: "number",
            description: "Only search within the last N minutes (default: 60). Ignored if `from` is set.",
          },
          from: {
            type: "string",
            description: "Start of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is interpreted as local-time start-of-day). Overrides `minutes`. When using a wide range, raise `limit` to avoid being capped.",
          },
          to: {
            type: "string",
            description: "End of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is end-of-day local). Optional upper bound. If `to` is given without `from`, the window is `minutes` wide ending at `to`.",
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
      name: "page_history",
      description:
        "Get the change history of a page. Returns the initial full capture followed by diffs showing what changed over time. Use after search_screen_history to dive deeper into a specific page.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: {
            type: "string",
            description: "Window/page title to search for (partial match)",
          },
          minutes: {
            type: "number",
            description: "How far back to look in minutes (default: 60). Ignored if `from` is set.",
          },
          from: {
            type: "string",
            description: "Start of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is interpreted as local-time start-of-day). Overrides `minutes`. When using a wide range, raise `limit` to avoid being capped.",
          },
          to: {
            type: "string",
            description: "End of time range (ISO datetime or YYYY-MM-DD; YYYY-MM-DD is end-of-day local). Optional upper bound. If `to` is given without `from`, the window is `minutes` wide ending at `to`.",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 50)",
          },
        },
        required: ["title"],
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
        `SELECT name, include_audio FROM channels ORDER BY id`
      ).all() as any[];

      if (channels.length === 0) {
        return { content: [{ type: "text" as const, text: "No channels configured. Create channels in the tunr TUI (tunr start)." }] };
      }

      const lines = channels.map((ch) => {
        const subscribed = subscribedChannels.has(ch.name);
        const icon = paused && subscribed ? "⏸" : subscribed ? "●" : "○";
        const status = paused && subscribed ? " (paused)" : subscribed ? " (subscribed)" : "";
        return `${icon} ${ch.name} [audio: ${ch.include_audio ? "on" : "off"}]${status}`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } finally {
      db.close();
    }
  }

  if (name === "subscribe") {
    const channel = String((args as any).channel || "").slice(0, 32);
    if (!channel || !/^[a-zA-Z0-9_\-]+$/.test(channel)) {
      return { content: [{ type: "text" as const, text: `Invalid channel name. Use alphanumeric, dash, or underscore (max 32 chars).` }] };
    }
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: "Database not available. Is the watch daemon running?" }] };
    }
    try {
      const exists = db.prepare(`SELECT 1 FROM channels WHERE name = ?`).get(channel);
      if (!exists) {
        const available = db.prepare(`SELECT name FROM channels ORDER BY id`).all() as any[];
        return { content: [{ type: "text" as const, text: `Channel "${channel}" does not exist. Available: ${available.map(c => c.name).join(", ") || "(none)"}` }] };
      }
      subscribedChannels.add(channel);
      const hasAudio = (db.prepare(`SELECT include_audio FROM channels WHERE name = ?`).get(channel) as any)?.include_audio;
      return { content: [{ type: "text" as const, text: `Subscribed to channel "${channel}". You will receive screen${hasAudio ? " and audio" : ""} notifications.` }] };
    } finally {
      db.close();
    }
  }

  if (name === "unsubscribe") {
    const channel = (args as any).channel as string;
    subscribedChannels.delete(channel);
    return { content: [{ type: "text" as const, text: `Unsubscribed from channel "${channel}".` }] };
  }

  if (name === "pause") {
    if (subscribedChannels.size === 0) {
      return { content: [{ type: "text" as const, text: "No active subscriptions to pause." }] };
    }
    paused = true;
    return { content: [{ type: "text" as const, text: `Paused ${subscribedChannels.size} subscription(s): ${[...subscribedChannels].join(", ")}` }] };
  }

  if (name === "resume") {
    if (!paused) {
      return { content: [{ type: "text" as const, text: "Subscriptions are not paused." }] };
    }
    paused = false;
    return { content: [{ type: "text" as const, text: `Resumed ${subscribedChannels.size} subscription(s): ${[...subscribedChannels].join(", ")}` }] };
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
      const limit = ((args as any).limit as number) || 20;
      const { fromIso: since, toIso, label: rangeLabel } = resolveRange(args, 60);
      // Build parameterized clauses for app/channel filters
      const extraClauses: string[] = [];
      const extraParams: any[] = [];
      if (toIso) {
        extraClauses.push(`timestamp <= ?`);
        extraParams.push(toIso);
      }
      if (appFilter) {
        extraClauses.push(`(app LIKE ? OR window_title LIKE ?)`);
        extraParams.push(`%${appFilter}%`, `%${appFilter}%`);
      }
      if (channelFilter) {
        extraClauses.push(`channel_names LIKE ?`);
        extraParams.push(`%${channelFilter}%`);
      }
      const extraWhere = extraClauses.length > 0 ? ` AND ${extraClauses.join(" AND ")}` : "";

      // Try vector search first (prefer diff_embedding, fallback to embedding)
      const queryVec = queryEmbedding(query);
      if (queryVec) {
        const screenRows = db.prepare(
          `SELECT timestamp, app, window_title, texts, diff_text, embedding, diff_embedding, channel_names, 'screen' as _type FROM screen_states
           WHERE timestamp > ? AND (embedding IS NOT NULL OR diff_embedding IS NOT NULL)${extraWhere}
           ORDER BY timestamp DESC LIMIT 200`
        ).all(since, ...extraParams) as any[];

        // Also search ingested table for vector matches (skip when appFilter is set — ingested has no app)
        let ingestedRows: any[] = [];
        if (!appFilter) {
          let ingestClauses = "timestamp > ? AND embedding IS NOT NULL";
          const ingestParams: any[] = [since];
          if (toIso) { ingestClauses += ` AND timestamp <= ?`; ingestParams.push(toIso); }
          if (channelFilter) {
            ingestClauses += ` AND channel_name = ?`;
            ingestParams.push(channelFilter);
          }
          ingestedRows = db.prepare(
            `SELECT timestamp, source, channel_name, text, embedding, 'ingested' as _type FROM ingested
             WHERE ${ingestClauses} ORDER BY timestamp DESC LIMIT 200`
          ).all(...ingestParams) as any[];
        }

        const allRows = [...screenRows, ...ingestedRows];
        if (allRows.length > 0) {
          const scored = allRows.map((r) => {
            let score = 0;
            let matchType = "full";
            if (r._type === "ingested") {
              if (r.embedding) {
                score = cosineSimilarity(queryVec, blobToFloat64Array(r.embedding));
                matchType = "ingested";
              }
            } else if (r.diff_embedding) {
              const diffEmb = blobToFloat64Array(r.diff_embedding);
              score = cosineSimilarity(queryVec, diffEmb);
              matchType = "diff";
            } else if (r.embedding) {
              const emb = blobToFloat64Array(r.embedding);
              score = cosineSimilarity(queryVec, emb);
            }
            return { ...r, score, matchType };
          }).sort((a, b) => b.score - a.score).slice(0, limit);

          const result = scored.map((r) => {
            if (r._type === "ingested") {
              const ch = r.channel_name ? ` [${r.channel_name}]` : "";
              return `[${formatLocal(r.timestamp)}] ingested:${r.source}${ch} (${r.matchType}: ${r.score.toFixed(3)})\n${r.text}`;
            }
            let texts: string[];
            try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
            const ch = r.channel_names ? ` [${r.channel_names}]` : "";
            const diff = r.diff_text ? `\n[diff]\n${r.diff_text}` : "";
            return `[${formatLocal(r.timestamp)}] ${r.app} — ${r.window_title}${ch} (${r.matchType}: ${r.score.toFixed(3)})${diff}\n${texts.join("\n")}`;
          }).join("\n\n---\n\n");

          return { content: [{ type: "text" as const, text: result }] };
        }
      }

      // Fallback to LIKE search (search in texts and diff_text)
      const screenRows = db.prepare(
        `SELECT timestamp, app, window_title, texts, diff_text, channel_names, 'screen' as _type FROM screen_states
         WHERE timestamp > ? AND (app LIKE ? OR window_title LIKE ? OR texts LIKE ? OR diff_text LIKE ?)${extraWhere}
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, ...extraParams, limit) as any[];

      // Also LIKE search ingested (skip when appFilter is set — ingested has no app)
      let ingestedRows: any[] = [];
      if (!appFilter) {
        let ingestLikeClauses = "timestamp > ? AND text LIKE ?";
        const ingestLikeParams: any[] = [since, `%${query}%`];
        if (toIso) { ingestLikeClauses += ` AND timestamp <= ?`; ingestLikeParams.push(toIso); }
        if (channelFilter) {
          ingestLikeClauses += ` AND channel_name = ?`;
          ingestLikeParams.push(channelFilter);
        }
        ingestedRows = db.prepare(
          `SELECT timestamp, source, channel_name, text, 'ingested' as _type FROM ingested
           WHERE ${ingestLikeClauses} ORDER BY timestamp DESC LIMIT ?`
        ).all(...ingestLikeParams, limit) as any[];
      }

      const rows = [...screenRows, ...ingestedRows]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No history matching "${query}" in ${rangeLabel}.` }] };
      }

      const result = rows.map((r) => {
        if (r._type === "ingested") {
          const ch = r.channel_name ? ` [${r.channel_name}]` : "";
          return `[${formatLocal(r.timestamp)}] ingested:${r.source}${ch}\n${r.text}`;
        }
        let texts: string[];
        try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
        const ch = r.channel_names ? ` [${r.channel_names}]` : "";
        const diff = r.diff_text ? `\n[diff]\n${r.diff_text}` : "";
        return `[${formatLocal(r.timestamp)}] ${r.app} — ${r.window_title}${ch}${diff}\n${texts.join("\n")}`;
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
      const limit = ((args as any)?.limit as number) || 20;
      const { fromIso: since, toIso, label: rangeLabel } = resolveRange(args, 10);

      const extraClauses: string[] = [];
      const extraParams: any[] = [];
      if (toIso) { extraClauses.push(`timestamp <= ?`); extraParams.push(toIso); }
      if (appFilter) {
        extraClauses.push(`(app LIKE ? OR window_title LIKE ?)`);
        extraParams.push(`%${appFilter}%`, `%${appFilter}%`);
      }
      if (channelFilter) {
        extraClauses.push(`channel_names LIKE ?`);
        extraParams.push(`%${channelFilter}%`);
      }
      const extraWhere = extraClauses.length > 0 ? ` AND ${extraClauses.join(" AND ")}` : "";

      const screenRows = db.prepare(
        `SELECT timestamp, app, window_title, texts, channel_names, 'screen' as _type FROM screen_states
         WHERE timestamp > ?${extraWhere}
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, ...extraParams, limit) as any[];

      // Also fetch recent ingested (skip when appFilter is set — ingested has no app)
      let ingestedRows: any[] = [];
      if (!appFilter) {
        let ingestWhere = "timestamp > ?";
        const ingestParams: any[] = [since];
        if (toIso) { ingestWhere += ` AND timestamp <= ?`; ingestParams.push(toIso); }
        if (channelFilter) {
          ingestWhere += ` AND channel_name = ?`;
          ingestParams.push(channelFilter);
        }
        ingestedRows = db.prepare(
          `SELECT timestamp, source, channel_name, text, 'ingested' as _type FROM ingested
           WHERE ${ingestWhere} ORDER BY timestamp DESC LIMIT ?`
        ).all(...ingestParams, limit) as any[];
      }

      const allRows = [...screenRows, ...ingestedRows]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limit);

      if (allRows.length === 0) {
        return { content: [{ type: "text" as const, text: `No screen history in ${rangeLabel}.` }] };
      }

      const content: any[] = [];
      for (const r of allRows) {
        if (r._type === "ingested") {
          const ch = r.channel_name ? ` [${r.channel_name}]` : "";
          content.push({ type: "text" as const, text: `[${formatLocal(r.timestamp)}] ingested:${r.source}${ch}\n${r.text}` });
        } else {
          let texts: string[];
          try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
          const ch = r.channel_names ? ` [${r.channel_names}]` : "";
          content.push({ type: "text" as const, text: `[${formatLocal(r.timestamp)}] ${r.app} — ${r.window_title}${ch}\n${texts.join("\n")}` });
        }
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
      const limit = ((args as any)?.limit as number) || 20;
      const source = (args as any)?.source as string | undefined;
      const { fromIso: since, toIso, label: rangeLabel } = resolveRange(args, 10);

      let sql = `SELECT timestamp, transcript, source FROM audio_transcripts WHERE timestamp > ?`;
      const params: any[] = [since];
      if (toIso) { sql += ` AND timestamp <= ?`; params.push(toIso); }
      if (source) { sql += ` AND source = ?`; params.push(source); }
      sql += ` ORDER BY timestamp DESC LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No audio transcripts in ${rangeLabel}.` }] };
      }

      const result = rows.map((r) =>
        `[${formatLocal(r.timestamp)}] [${r.source || "system"}] ${r.transcript}`
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
      const limit = ((args as any).limit as number) || 20;
      const source = (args as any)?.source as string | undefined;
      const { fromIso: since, toIso, label: rangeLabel } = resolveRange(args, 60);

      let sql = `SELECT timestamp, transcript, source FROM audio_transcripts WHERE timestamp > ? AND transcript LIKE ?`;
      const params: any[] = [since, `%${query}%`];
      if (toIso) { sql += ` AND timestamp <= ?`; params.push(toIso); }
      if (source) { sql += ` AND source = ?`; params.push(source); }
      sql += ` ORDER BY timestamp DESC LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No audio transcripts matching "${query}" in ${rangeLabel}.` }] };
      }

      const result = rows.map((r) =>
        `[${formatLocal(r.timestamp)}] [${r.source || "system"}] ${r.transcript}`
      ).join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: result }] };
    } finally {
      db.close();
    }
  }

  if (name === "page_history") {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: "No screen history available. Is the watch daemon running?" }] };
    }
    try {
      const titleFilter = (args as any).title as string;
      const limit = ((args as any).limit as number) || 50;
      const { fromIso: since, toIso, label: rangeLabel } = resolveRange(args, 60);

      let sql = `SELECT timestamp, app, window_title, window_id, texts, diff_text FROM screen_states
         WHERE timestamp > ? AND window_title LIKE ?`;
      const params: any[] = [since, `%${titleFilter}%`];
      if (toIso) { sql += ` AND timestamp <= ?`; params.push(toIso); }
      sql += ` ORDER BY timestamp ASC LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No page history matching "${titleFilter}" in ${rangeLabel}.` }] };
      }

      const result = rows.map((r, i) => {
        const isInitial = !r.diff_text;
        if (isInitial) {
          let texts: string[];
          try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
          return `[${formatLocal(r.timestamp)}] ${r.app} — ${r.window_title} (initial)\n${texts.join("\n")}`;
        } else {
          return `[${formatLocal(r.timestamp)}] ${r.app} — ${r.window_title} (diff)\n${r.diff_text}`;
        }
      }).join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: result }] };
    } finally {
      db.close();
    }
  }

  return { content: [{ type: "text" as const, text: "Unknown tool" }] };
});

// --- In-memory subscription state (per MCP server process = per Claude Code session) ---
const subscribedChannels = new Set<string>();
let paused = false;

// Poll DB for new screen/audio records and notify subscribed channels
let lastScreenId = 0;
let lastAudioId = 0;
let lastIngestedId = 0;
// Track last notified content per window (keyed by "app\0window_title")
const lastNotified = new Map<string, { title: string; lines: string[] }>();
// Track content hash per window per channel — skip duplicate notifications
const sentHashes = new Map<string, Map<string, number>>();

function hashLines(lines: string[]): number {
  const hasher = new Bun.CryptoHasher("md5");
  hasher.update(lines.join("\n"));
  // Use first 8 bytes as a number for cheap comparison
  const buf = hasher.digest();
  return buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
}

async function pollDb() {
  // Initialize cursors to latest IDs
  const initDb = openDb();
  if (initDb) {
    try {
      const s = initDb.prepare("SELECT MAX(id) as m FROM screen_states").get() as any;
      const a = initDb.prepare("SELECT MAX(id) as m FROM audio_transcripts").get() as any;
      const ig = initDb.prepare("SELECT MAX(id) as m FROM ingested").get() as any;
      lastScreenId = s?.m || 0;
      lastAudioId = a?.m || 0;
      lastIngestedId = ig?.m || 0;
    } finally {
      initDb.close();
    }
  }

  while (true) {
    await Bun.sleep(2000);

    const db = openDb();
    if (!db) continue;
    try {
      // Get active subscriptions from memory
      const subNames = paused ? [] : [...subscribedChannels];
      if (subNames.length === 0) {
        // Advance cursors so paused period is skipped on resume
        const maxScreen = db.prepare("SELECT MAX(id) as m FROM screen_states").get() as any;
        const maxAudio = db.prepare("SELECT MAX(id) as m FROM audio_transcripts").get() as any;
        const maxIngested = db.prepare("SELECT MAX(id) as m FROM ingested").get() as any;
        if (maxScreen?.m) lastScreenId = maxScreen.m;
        if (maxAudio?.m) lastAudioId = maxAudio.m;
        if (maxIngested?.m) lastIngestedId = maxIngested.m;
        continue;
      }

      // New screen records
      const screens = db.prepare(
        "SELECT id, timestamp, pid, window_index, window_id, app, window_title, texts, channel_names, screenshot_path FROM screen_states WHERE id > ? ORDER BY id"
      ).all(lastScreenId) as any[];

      for (const r of screens) {
        lastScreenId = r.id;
        let chans: string[];
        try { chans = r.channel_names ? JSON.parse(r.channel_names) : []; } catch { chans = []; }
        const isUserSend = chans.includes("__send__");
        const matched = isUserSend
          ? subNames  // user_send → notify all subscribed channels
          : chans.filter(ch => subNames.includes(ch));
        if (matched.length === 0) continue;

        let texts: string[];
        try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
        const lines = texts.join("\n").split("\n");
        const wKey = r.window_id ? `wid:${r.window_id}` : `${r.pid}:${r.window_index}`;
        const prev = lastNotified.get(wKey);
        const contentHash = hashLines(lines);

        let content: string;
        if (!prev || prev.title !== r.window_title) {
          // New window or title changed (page navigation) — full text as all-add diff
          content = `**${r.app}** — "${r.window_title}"\n${lines.map(l => `+${l}`).join("\n")}`;
        } else {
          // Same window & title, text changed — diff only
          const diff = makeDiff(prev.lines, lines);
          content = `**${r.app}** — "${r.window_title}"\n${diff}`;
        }
        if (r.screenshot_path) {
          content += `\n[screenshot: ${r.screenshot_path}]`;
        }
        lastNotified.set(wKey, { title: r.window_title, lines });

        const event = isUserSend ? "user_send" : "screen";

        for (const ch of matched) {
          // Skip if same content was already sent for this page+channel (unless user_send)
          // Key by window+title so tab switches don't overwrite each other's hashes
          const hashKey = `${wKey}\0${r.window_title}`;
          if (!isUserSend) {
            const chHashes = sentHashes.get(ch);
            if (chHashes?.get(hashKey) === contentHash) continue;
          }
          // Update hash
          let chHashes = sentHashes.get(ch);
          if (!chHashes) { chHashes = new Map(); sentHashes.set(ch, chHashes); }
          chHashes.set(hashKey, contentHash);

          const meta: any = { source: "tunr", event, channel: ch, timestamp: r.timestamp };
          if (r.screenshot_path) meta.screenshot_path = r.screenshot_path;

          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: `[${ch}] Screen update:\n\n${content}`,
              meta,
            },
          });
        }
      }

      // New audio records
      const audios = db.prepare(
        "SELECT id, timestamp, transcript, source FROM audio_transcripts WHERE id > ? ORDER BY id"
      ).all(lastAudioId) as any[];

      // Find channels with audio or mic enabled
      const audioChans = db.prepare("SELECT name FROM channels WHERE include_audio = 1").all() as any[];
      const audioSubbed = audioChans.map((c: any) => c.name).filter((n: string) => subNames.includes(n));
      const micChans = db.prepare("SELECT name FROM channels WHERE include_mic = 1").all() as any[];
      const micSubbed = micChans.map((c: any) => c.name).filter((n: string) => subNames.includes(n));

      for (const r of audios) {
        lastAudioId = r.id;
        const src = r.source || "system";
        const targetChans = src === "mic" ? micSubbed : audioSubbed;
        if (targetChans.length === 0) continue;
        const label = src === "mic" ? "Mic transcript" : "Audio transcript";

        for (const ch of targetChans) {
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: `[${ch}] ${label}:\n${r.transcript}`,
              meta: { source: "tunr", event: "audio", channel: ch, timestamp: r.timestamp, audioSource: src },
            },
          });
        }
      }

      // New ingested records
      const ingested = db.prepare(
        "SELECT id, timestamp, source, channel_name, text, meta FROM ingested WHERE id > ? ORDER BY id"
      ).all(lastIngestedId) as any[];

      for (const r of ingested) {
        lastIngestedId = r.id;
        if (!r.channel_name) continue;
        if (!subNames.includes(r.channel_name)) continue;

        const metaStr = r.meta ? ` ${r.meta}` : "";
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[${r.channel_name}] Ingested (${r.source})${metaStr}:\n${r.text}`,
            meta: { source: "tunr", event: "ingested", channel: r.channel_name, timestamp: r.timestamp },
          },
        });
      }
    } finally {
      db.close();
    }
  }
}

await mcp.connect(new StdioServerTransport());
pollDb();
