#!/usr/bin/env bun
/**
 * tunr — Screen context provider for Claude Code
 *
 * Usage:
 *   tunr mcp      Start the MCP server (called by Claude Code)
 *   tunr send     Send current screen to Claude Code
 *   tunr watch    Start the watch daemon with TUI
 */

const command = process.argv[2];

switch (command) {
  case "mcp":
    await import("./mcp-server.ts");
    break;
  case "send": {
    const { join, dirname } = await import("path");
    const sendPath = join(dirname(process.execPath), "tunr-send");
    const result = Bun.spawnSync([sendPath], { stdout: "inherit", stderr: "inherit" });
    process.exit(result.exitCode);
  }
  case "watch":
    await import("./daemon.tsx");
    break;
  case "--version":
  case "-v":
    console.log((await import("./package.json")).version);
    break;
  default:
    console.log(`tunr — Screen context provider for Claude Code

Usage:
  tunr mcp      Start the MCP server
  tunr send     Send current screen to Claude Code
  tunr watch    Start the watch daemon with TUI`);
    process.exit(command ? 1 : 0);
}
