# uitocc

Screen context provider for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Captures your macOS screen via the Accessibility API and delivers what you're looking at — visible text, window titles — directly into your Claude Code session through MCP.

## Install

```bash
brew install moeki0/tap/uitocc
```

Grant Accessibility and Screen Recording permissions to your terminal app.

Register the MCP server and enable channels:

```bash
claude mcp add -s user uitocc -- uitocc mcp
```

```json5
// ~/.claude/settings.json
{
  "experimentalFeatures": {
    "channels": true
  }
}
```

## Usage

### Watch daemon (continuous)

Start the TUI daemon to continuously observe your screen:

```bash
uitocc watch
```

A terminal UI shows all detected windows. Each new window triggers a permission prompt — press `y` to allow observation or `n` to deny. Allowed windows are periodically recorded to a local SQLite database.

Claude Code can then search your screen history via MCP tools:

- `search_screen_history(query, minutes?, limit?)` — search observed screen text by keyword
- `recent_screens(minutes?, limit?)` — list recent screen states

### Send (one-shot)

Run from a keyboard shortcut (e.g. via Raycast or macOS Shortcuts):

```bash
uitocc send
```

Captures the frontmost app's window title, visible text, and cursor context, then sends it as a channel event to Claude Code.

## Plugin

uitocc includes a Claude Code plugin that auto-invokes when you reference screen content (e.g. "what was I just looking at", "that page I had open"). Install as a plugin to enable this:

In Claude Code:

```
/plugin marketplace add moeki0/uitocc-skill
/plugin install uitocc@uitocc
```

## Architecture

```
                          ┌──────────────┐
uitocc watch ──poll──▶    │  SQLite DB   │
  (TUI daemon)            └──────┬───────┘
  per-window permissions         │
                          ┌──────▼───────┐
uitocc send ──────────▶   │mcp-server.ts │───▶ Claude Code
  (one-shot, AX API)      │ (MCP/stdio)  │
                          └──────────────┘
```

- **uitocc watch** — TUI daemon (Ink/React) that polls all windows, asks per-window permission, records allowed window text to SQLite
- **uitocc mcp** — MCP server with `search_screen_history` / `recent_screens` tools, plus channel notifications for `uitocc send`
- **uitocc send** — Captures current window text and cursor context via Accessibility API
- **uitocc-ax-text** — Extracts visible text from windows (`--all` for all windows as JSON)

## License

MIT
