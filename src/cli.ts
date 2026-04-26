#!/usr/bin/env bun
/**
 * tunr — Screen context provider for Claude Code
 *
 * Usage:
 *   tunr mcp      Start the MCP server (called by Claude Code)
 *   tunr send     Send current screen to Claude Code
 *   tunr start    Start the watch daemon with TUI
 */

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "mcp":
    await import("./mcp-server.ts");
    break;
  case "send":
    await import("./send.ts");
    break;
  case "start":
    await import("./daemon.tsx");
    break;
  case "ingest":
    await import("./ingest.ts");
    break;
  case "setup": {
    const { runSetup } = await import("./setup.ts");
    await runSetup(args);
    break;
  }
  case "doctor": {
    const { runDoctor } = await import("./doctor.ts");
    await runDoctor();
    break;
  }
  case "--version":
  case "-v":
    const { VERSION } = await import("./lib/constants");
    console.log(VERSION);
    break;
  default:
    console.log(`tunr — Screen context provider for Claude Code

Usage:
  tunr start         Start the watch daemon with TUI
  tunr mcp           Start the MCP server
  tunr send          Send current screen to Claude Code
  tunr ingest        Ingest text from stdin into tunr
  tunr setup         Set up permissions and MCP registration
  tunr setup --audio Set up audio capture
  tunr doctor        Check your tunr installation

Ingest:
  echo "text" | tunr ingest --source <name> [--channel <name>] [--meta key=value]`);
    process.exit(command ? 1 : 0);
}
