#!/usr/bin/env bun
/**
 * tunr ingest — Ingest arbitrary text into tunr's database from stdin
 *
 * Usage:
 *   echo "some text" | tunr ingest --source git --channel dev --meta "repo=tunr"
 */

import { insertIngestedStmt } from "./lib/db";
import { generateEmbedding } from "./lib/capture";

// Parse args
const args = process.argv.slice(3);
let source = "";
let channel: string | null = null;
const meta: Record<string, string> = {};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--source":
      source = args[++i] || "";
      break;
    case "--channel":
      channel = args[++i] || null;
      break;
    case "--meta":
      const kv = args[++i] || "";
      const eq = kv.indexOf("=");
      if (eq > 0) {
        meta[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      break;
  }
}

if (!source) {
  console.error("Error: --source is required");
  console.error("Usage: echo 'text' | tunr ingest --source <name> [--channel <name>] [--meta key=value]");
  process.exit(1);
}

// Read stdin
const chunks: Buffer[] = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(Buffer.from(chunk));
}
const text = Buffer.concat(chunks).toString("utf-8").trim();

if (!text) {
  console.error("Error: no input on stdin");
  process.exit(1);
}

// Generate embedding (reuse shared helper, truncate to 2000 chars)
const embedding = generateEmbedding(text.slice(0, 2000));

const timestamp = new Date().toISOString();
const metaJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;

insertIngestedStmt.run(timestamp, source, channel, text, metaJson, embedding);

console.log(`Ingested ${text.length} chars from "${source}"${channel ? ` → channel "${channel}"` : ""}`);
