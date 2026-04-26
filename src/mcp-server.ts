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
            description: "How far back to look in minutes (default: 60)",
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
      const minutes = ((args as any).minutes as number) || 60;
      const limit = ((args as any).limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();
      // Build parameterized clauses for app/channel filters
      const extraClauses: string[] = [];
      const extraParams: any[] = [];
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
              return `[${r.timestamp}] ingested:${r.source}${ch} (${r.matchType}: ${r.score.toFixed(3)})\n${r.text}`;
            }
            let texts: string[];
            try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
            const ch = r.channel_names ? ` [${r.channel_names}]` : "";
            const diff = r.diff_text ? `\n[diff]\n${r.diff_text}` : "";
            return `[${r.timestamp}] ${r.app} — ${r.window_title}${ch} (${r.matchType}: ${r.score.toFixed(3)})${diff}\n${texts.join("\n")}`;
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
        return { content: [{ type: "text" as const, text: `No history matching "${query}" in the last ${minutes} minutes.` }] };
      }

      const result = rows.map((r) => {
        if (r._type === "ingested") {
          const ch = r.channel_name ? ` [${r.channel_name}]` : "";
          return `[${r.timestamp}] ingested:${r.source}${ch}\n${r.text}`;
        }
        let texts: string[];
        try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
        const ch = r.channel_names ? ` [${r.channel_names}]` : "";
        const diff = r.diff_text ? `\n[diff]\n${r.diff_text}` : "";
        return `[${r.timestamp}] ${r.app} — ${r.window_title}${ch}${diff}\n${texts.join("\n")}`;
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

      const extraClauses: string[] = [];
      const extraParams: any[] = [];
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
        return { content: [{ type: "text" as const, text: `No screen history in the last ${minutes} minutes.` }] };
      }

      const content: any[] = [];
      for (const r of allRows) {
        if (r._type === "ingested") {
          const ch = r.channel_name ? ` [${r.channel_name}]` : "";
          content.push({ type: "text" as const, text: `[${r.timestamp}] ingested:${r.source}${ch}\n${r.text}` });
        } else {
          let texts: string[];
          try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
          const ch = r.channel_names ? ` [${r.channel_names}]` : "";
          content.push({ type: "text" as const, text: `[${r.timestamp}] ${r.app} — ${r.window_title}${ch}\n${texts.join("\n")}` });
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

  if (name === "page_history") {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text" as const, text: "No screen history available. Is the watch daemon running?" }] };
    }
    try {
      const titleFilter = (args as any).title as string;
      const minutes = ((args as any).minutes as number) || 60;
      const limit = ((args as any).limit as number) || 50;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();

      const rows = db.prepare(
        `SELECT timestamp, app, window_title, window_id, texts, diff_text FROM screen_states
         WHERE timestamp > ? AND window_title LIKE ?
         ORDER BY timestamp ASC LIMIT ?`
      ).all(since, `%${titleFilter}%`, limit) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No page history matching "${titleFilter}" in the last ${minutes} minutes.` }] };
      }

      const result = rows.map((r, i) => {
        const isInitial = !r.diff_text;
        if (isInitial) {
          let texts: string[];
          try { texts = JSON.parse(r.texts) as string[]; } catch { texts = []; }
          return `[${r.timestamp}] ${r.app} — ${r.window_title} (initial)\n${texts.join("\n")}`;
        } else {
          return `[${r.timestamp}] ${r.app} — ${r.window_title} (diff)\n${r.diff_text}`;
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

// Compact diff — only changed lines with position info
function makeDiff(oldLines: string[], newLines: string[]): string {
  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops: { type: " " | "-" | "+"; text: string }[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: " ", text: oldLines[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "+", text: newLines[j - 1] }); j--;
    } else {
      ops.push({ type: "-", text: oldLines[i - 1] }); i--;
    }
  }
  ops.reverse();

  // Output only - and + lines with @@ position headers
  const changes = ops.map((o, idx) => ({ ...o, idx })).filter(o => o.type !== " ");
  if (changes.length === 0) return "";

  const result: string[] = [];
  let lastHunkOldLine = -1;
  let oldLine = 1, newLine = 1;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type === " ") { oldLine++; newLine++; continue; }
    // Emit position header when there's a gap
    if (oldLine !== lastHunkOldLine + 1 || result.length === 0) {
      result.push(`@@ -${oldLine} +${newLine} @@`);
    }
    result.push(`${ops[k].type}${ops[k].text}`);
    if (ops[k].type === "-") { lastHunkOldLine = oldLine; oldLine++; }
    else { lastHunkOldLine = oldLine; newLine++; }
  }
  return result.join("\n");
}

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
        "SELECT id, timestamp, pid, window_index, window_id, app, window_title, texts, channel_names FROM screen_states WHERE id > ? ORDER BY id"
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

          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: `[${ch}] Screen update:\n\n${content}`,
              meta: { source: "tunr", event, channel: ch, timestamp: r.timestamp },
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
