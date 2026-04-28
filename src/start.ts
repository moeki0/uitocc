#!/usr/bin/env bun
/**
 * tunr start — foreground engine (no TUI).
 * Logs status lines to stdout. Ctrl-C to stop.
 */

import { startEngine } from "./lib/engine";
import { db } from "./lib/db";
import { VERSION } from "./lib/constants";

console.log(`tunr ${VERSION} — foreground engine started. Ctrl-C to stop.`);
const handle = startEngine();

const shutdown = (signal: string) => {
  console.log(`\nReceived ${signal}, shutting down...`);
  handle.stop();
  try { db.close(); } catch {}
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
