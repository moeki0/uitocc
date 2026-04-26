# tunr

Screen & audio context provider for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

tunr captures your macOS screen and system audio, then delivers it to Claude Code through MCP — so Claude can see what you're looking at and hear what you're listening to.

## What it does

- **Screen capture** — Reads visible text from macOS windows via the Accessibility API. Debounce-based recording captures settled content, and channel notifications use compact unified diffs to minimize context usage
- **Audio capture** (optional) — System audio via BlackHole + local transcription with whisper.cpp
- **Channels** — Group windows into named channels, subscribe from Claude Code for real-time updates
- **Deny list** — Glob-based rules to block specific apps, titles, or URLs from ever being captured
- **Search** — Vector similarity search and keyword search over screen and audio history
- **Privacy-first** — All data stays local in SQLite. Only assigned windows are captured. Deny list rules override all channel assignments. No data leaves your machine unless Claude Code reads it

## Install

```bash
brew install moeki0/tunr/tunr
```

### Permissions

Grant these permissions to your terminal app (System Settings > Privacy & Security):

- **Accessibility** — Required for reading window text

### Chrome web content (optional)

To capture web page text from Chrome (not just tab titles), enable AppleScript JS execution:

```bash
defaults write com.google.Chrome AllowJavaScriptAppleEvents -bool true
```

This persists across Chrome restarts. To disable: `defaults delete com.google.Chrome AllowJavaScriptAppleEvents`

Other Chromium browsers work too:

```bash
defaults write com.microsoft.edgemac AllowJavaScriptAppleEvents -bool true
defaults write com.brave.Browser AllowJavaScriptAppleEvents -bool true
```

> **Security note:** This allows any app with macOS Automation permission to execute JavaScript in your Chrome tabs via AppleScript. macOS TCC requires explicit per-app Automation access, so only apps you approve can use this. If you're concerned, leave this off — tunr will still capture window titles and native app text via the Accessibility API.

### MCP server setup

Register the MCP server with Claude Code:

```bash
claude mcp add -s user tunr -- tunr mcp
```

Start Claude Code with channels enabled (required for real-time streaming). The flag name sounds scary but it just enables the MCP channel protocol — no security risk:

```bash
claude --dangerously-load-development-channels server:tunr
```

### Audio setup (optional — skip this if you only need screen capture)

Audio capture requires [BlackHole](https://github.com/ExistentialAudio/BlackHole) as a virtual audio loopback device.

1. Install BlackHole:

```bash
brew install --cask blackhole-2ch
```

2. Open **Audio MIDI Setup** (in /Applications/Utilities)
3. Click **+** at the bottom left and select **Create Multi-Output Device**
4. Check both your speakers/headphones and **BlackHole 2ch**
5. Set the multi-output device as your system output

Download the whisper.cpp model for transcription:

```bash
curl -L -o ~/.cache/whisper-cpp-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

Install whisper-cpp (if not already installed):

```bash
brew install whisper-cpp
```

## Usage

### Start the daemon

```bash
tunr start
```

This opens a terminal UI with two panels:

#### SOURCES

Shows all detected windows. Each window starts unassigned (gray). Use **Enter** to assign a window to a channel — only assigned windows are captured and broadcast.

- Single channel: Enter toggles assignment directly
- Multiple channels: Enter opens a channel picker

#### FEED

Shows captured screen and audio entries in reverse chronological order. Filter by type (`1` screen, `2` audio), channel (`3`-`9` for up to 7 channels), or search (`/`).

### TUI controls

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate lists |
| `Enter` | Assign channel (SOURCES) / View detail (FEED) |
| `Tab` | Switch focus between SOURCES and FEED |
| `S` | Open settings |
| `C` | Calendar view |
| `1` `2` | Toggle screen/audio filter |
| `3`-`9` | Toggle channel filter |
| `/` | Search captures |
| `Q` | Quit |

### Channels

Channels are named groups of windows. Create channels in **Settings > Channels**, then assign windows to them in the SOURCES panel. Only windows assigned to a channel are captured and broadcast to Claude Code.

- A window can belong to multiple channels
- Claude Code subscribes to channels via `subscribe(channel)` to receive real-time updates
- Unassigned windows are never captured

#### Settings > Channels

| Key | Action |
|-----|--------|
| `C` | Create channel |
| `X` | Delete channel |

#### Settings > Deny List

Block specific apps, window titles, or URLs from ever being captured. Rules use glob matching (`*` as wildcard, exact match otherwise). Multi-field rules use AND logic — all specified fields must match.

| Key | Action |
|-----|--------|
| `C` | Create deny rule |
| `Tab` | Switch field (app/title/url) |
| `X` | Delete rule |

Examples: `app: 1Password`, `url: *mail.google.com*`, `app: Google Chrome` + `url: *private*`

### Send (one-shot)

Capture the frontmost window and send it to Claude Code instantly:

```bash
tunr send
```

Bind this to a keyboard shortcut (e.g. via Raycast or macOS Shortcuts) for quick screen sharing.

## MCP Tools

These tools are available to Claude Code when the MCP server is running:

### Channel controls

| Tool | Description |
|------|-------------|
| `list_channels()` | List available channels and subscription status |
| `subscribe(channel)` | Subscribe to a channel for real-time notifications |
| `unsubscribe(channel)` | Stop receiving from a channel |
| `pause()` | Pause all subscriptions (remembered for resume) |
| `resume()` | Resume all paused subscriptions |

### Screen tools

| Tool | Description |
|------|-------------|
| `search_screen_history(query, channel?, app?, minutes?, limit?)` | Search screen text (vector similarity + keyword fallback) |
| `recent_screens(channel?, app?, minutes?, limit?)` | Get recent screen states |

### Audio tools

| Tool | Description |
|------|-------------|
| `recent_audio(channel?, minutes?, limit?)` | Get recent audio transcriptions |
| `search_audio(query, channel?, minutes?, limit?)` | Search audio transcriptions by keyword |

## Plugin

tunr includes a Claude Code plugin with slash commands for channel management:

| Command | Description |
|---------|-------------|
| `/tunr:subscribe <channels>` | Subscribe to channels (e.g. `dev` or `dev,research`) |
| `/tunr:unsubscribe <channels>` | Unsubscribe from channels |
| `/tunr:pause` | Pause all subscriptions (remembered for resume) |
| `/tunr:resume` | Resume paused subscriptions |

```bash
/plugin marketplace add moeki0/tunr-skill && /plugin install tunr@tunr
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  tunr start (TUI)                   │
│                                                     │
│  ┌─ SOURCES ──────────────────────────────────────┐ │
│  │  Window A  [work]        ← assigned, captured  │ │
│  │  Window B  —             ← unassigned, ignored │ │
│  │  Window C  [work,hobby]  ← multi-channel       │ │
│  │  Audio     [work]        ← audio capture       │ │
│  └────────────────────────────────────────────────┘ │
│           │                        │                │
│           ▼                        ▼                │
│        ┌──────────────────────────────┐             │
│        │     SQLite (local DB)        │             │
│        └──────────────────────────────┘             │
│           │                                         │
│           ▼                                         │
│  ┌─ BROADCAST ────────────────────────────────────┐ │
│  │  Subscribed channels → channel events          │ │
│  └────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
          ┌────────────────┐
          │ mcp-server.ts  │
          │  (MCP/stdio)   │──────▶  Claude Code
          │                │  tools / channels
          └────────────────┘

tunr send ──────────────────────▶  SQLite (direct write)
  (one-shot, AX API)
```

### Components

| File | Description |
|------|-------------|
| `daemon.tsx` | TUI daemon (Ink/React). Polls windows, manual channel assignment, records to SQLite, manages audio capture |
| `mcp-server.ts` | MCP server. Provides search/history tools and channel event polling |
| `cli.ts` | CLI entry point (`start`, `mcp`, `send`, `--version`) |
| `ax_text.swift` | Accessibility API text extractor. `--all` returns all windows as JSON with URLs for browser tabs. Uses AppleScript JS for Chrome web content |
| `send.ts` | One-shot screen capture. Reads frontmost window via ax_text and writes directly to DB |
| `embed.swift` | NLEmbedding (macOS NaturalLanguage framework) for 512-dim sentence embeddings used in vector search |
| `audio_capture.swift` | System audio capture via AVFoundation + BlackHole. Records WAV chunks at 16kHz mono |

### Data storage

All data is stored locally at `~/Library/Application Support/tunr/`:

- `tunr.db` — SQLite database with screen states and audio transcripts
- `settings.json` — Recording settings, deny list rules

## License

MIT
