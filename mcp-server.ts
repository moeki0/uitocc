#!/usr/bin/env bun
/**
 * uitocc MCP server — Provides screen context to Claude Code
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "os";
import { join } from "path";
import { existsSync, unlinkSync } from "fs";

const DATA_DIR = join(homedir(), "Library", "Application Support", "uitocc");
const CHANNEL_EVENT_PATH = join(DATA_DIR, "channel_event.json");

const mcp = new Server(
  { name: "uitocc", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "uitocc events arrive as <channel source=\"uitocc\" ...>.",
      "event=user_send: User pressed shortcut to share current screen.",
    ].join(" "),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

mcp.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text" as const, text: "Unknown tool" }],
}));

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
      if (event.audioTranscription) {
        content += `\n\nRecent system audio:\n${event.audioTranscription}`;
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
