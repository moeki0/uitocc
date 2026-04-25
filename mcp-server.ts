#!/usr/bin/env bun
/**
 * uitocc MCP server — Provides screen context to Claude Code
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync, unlinkSync } from "fs";

const DATA_DIR = join(homedir(), "Library", "Application Support", "uitocc");
const CHANNEL_EVENT_PATH = join(DATA_DIR, "channel_event.json");
const DB_PATH = join(DATA_DIR, "uitocc.db");

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
const EMBED_PATH = join(dirname(process.execPath), "uitocc-embed");
const EMBED_FALLBACK = join(import.meta.dir, "uitocc-embed");
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

function blobToFloat64Array(blob: Buffer): Float64Array {
  const arr = new Float64Array(blob.length / 8);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = blob.readDoubleBE(i * 8);
  }
  return arr;
}

const mcp = new Server(
  { name: "uitocc", version: "0.6.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "uitocc events arrive as <channel source=\"uitocc\" ...>.",
      "event=user_send: User pressed shortcut to share current screen.",
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
      const minutes = ((args as any).minutes as number) || 60;
      const limit = ((args as any).limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();

      // Try vector search first
      const queryVec = queryEmbedding(query);
      if (queryVec) {
        const rows = db.prepare(
          `SELECT timestamp, app, window_title, texts, embedding FROM screen_states
           WHERE timestamp > ? AND embedding IS NOT NULL
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
         WHERE timestamp > ? AND (app LIKE ? OR window_title LIKE ? OR texts LIKE ?)
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
      const minutes = ((args as any)?.minutes as number) || 10;
      const limit = ((args as any)?.limit as number) || 20;
      const since = new Date(Date.now() - minutes * 60_000).toISOString();

      const rows = db.prepare(
        `SELECT timestamp, app, window_title, texts FROM screen_states
         WHERE timestamp > ?
         ORDER BY timestamp DESC LIMIT ?`
      ).all(since, limit) as any[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No screen history in the last ${minutes} minutes.` }] };
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

  return { content: [{ type: "text" as const, text: "Unknown tool" }] };
});

async function pollChannelEvents() {
  while (true) {
    await Bun.sleep(1000);
    if (!existsSync(CHANNEL_EVENT_PATH)) continue;

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
            source: "uitocc",
            event: "user_send",
            app: event.app,
            windowTitle: event.windowTitle,
          },
        },
      });
    } catch {}
  }
}

await mcp.connect(new StdioServerTransport());
pollChannelEvents();
