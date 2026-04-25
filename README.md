# tunr

Screen & audio context provider for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

tunr captures your macOS screen and system audio, then delivers it to Claude Code through MCP — so Claude can see what you're looking at and hear what you're listening to.

## What it does

- **Screen recording** — Captures visible text and window titles from your macOS windows via the Accessibility API, with web page content from Chrome via AppleScript
- **Audio recording** — Captures system audio via BlackHole virtual audio device and transcribes it locally with whisper.cpp
- **TV channel** — Streams screen changes to Claude Code in real-time
- **RADIO channel** — Streams audio transcriptions to Claude Code in real-time
- **Search** — Claude Code can search your screen and audio history via MCP tools
- **Privacy-first** — All data stays local. Per-window permission control. No data leaves your machine unless Claude Code reads it.

## Install

```bash
brew install moeki0/tunr/tunr
```

### Permissions

Grant these permissions to your terminal app (System Settings > Privacy & Security):

- **Accessibility** — Required for reading window text

### Chrome web content (optional)

To capture web page text from Chrome (not just tab titles), enable AppleScript JS execution:

1. Open Chrome
2. Menu bar: **View** > **Developer** > **Allow JavaScript from Apple Events**

This also works with other Chromium browsers (Edge, Brave, Vivaldi, Opera).

> **Security note:** This setting allows any app with macOS Automation permission to execute JavaScript in your Chrome tabs via AppleScript. macOS TCC requires you to explicitly grant Automation access per-app, so only apps you approve can use this. However, if a malicious app gains Automation permission, it could read page content or manipulate DOM in any tab. If you're concerned, leave this setting off — tunr will still capture window titles and native app text via the Accessibility API.

### MCP server setup

Register the MCP server with Claude Code:

```bash
claude mcp add -s user tunr -- tunr mcp
```

Start Claude Code with channels enabled (required for TV/RADIO real-time streaming):

```bash
claude --dangerously-load-development-channels server:tunr
```

### Audio setup (optional)

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

### Watch daemon

Start the TUI daemon:

```bash
tunr watch
```

This opens a terminal UI with two main sections:

#### RECORDING

Records your screen and audio to a local SQLite database.

- **SCREEN** — Shows all detected windows. New windows trigger a permission prompt. Allowed windows are periodically recorded (text). Content changes are deduplicated automatically.
- **AUDIO** — Captures system audio in 10-second chunks and transcribes them locally with whisper.cpp. Shows the latest transcription.

#### BROADCAST

Streams recordings to Claude Code in real-time via MCP channel events.

- **TV** — When enabled, screen content changes are pushed to Claude Code as they happen
- **RADIO** — When enabled, audio transcriptions are pushed to Claude Code every ~10 seconds

### TUI controls

| Key | Action |
|-----|--------|
| `↑` `↓` | Navigate feed list |
| `T` | Toggle selected feed (allow/deny) |
| `Y` / `N` | Grant/deny new feed |
| `A` | Toggle audio recording on/off |
| `1` | Toggle TV channel on/off |
| `2` | Toggle RADIO channel on/off |
| `Q` | Quit |

### Send (one-shot)

Capture the frontmost window and send it to Claude Code instantly:

```bash
tunr send
```

Bind this to a keyboard shortcut (e.g. via Raycast or macOS Shortcuts) for quick screen sharing.

## MCP Tools

These tools are available to Claude Code when the MCP server is running:

### Screen tools

| Tool | Description |
|------|-------------|
| `search_screen_history(query, app?, minutes?, limit?)` | Search screen text by keyword. Filter by app/window name with `app` parameter |
| `recent_screens(app?, minutes?, limit?)` | Get recent screen states |

### Audio tools

| Tool | Description |
|------|-------------|
| `recent_audio(minutes?, limit?)` | Get recent audio transcriptions |
| `search_audio(query, minutes?, limit?)` | Search audio transcriptions by keyword |

### Channel controls

| Tool | Description |
|------|-------------|
| `toggle_tv(enabled)` | Enable/disable real-time screen change notifications |
| `toggle_radio(enabled)` | Enable/disable real-time audio transcription notifications |

## Plugin

tunr includes a Claude Code plugin that auto-invokes when you reference screen or audio content (e.g. "what was I just looking at", "what did they say in the video").

```
/install-plugin moeki0/tunr-skill
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  tunr watch (TUI)                  │
│                                                     │
│  ┌─ RECORDING ────────────────────────────────────┐ │
│  │                                                │ │
│  │  SCREEN                     AUDIO              │ │
│  │  ├ AX API polling           ├ BlackHole capture│ │
│  │  ├ Per-window permissions   ├ whisper.cpp      │ │
│  │  └ AppleScript (Chrome)     └ Transcriptions   │ │
│  │           │                        │           │ │
│  │           ▼                        ▼           │ │
│  │        ┌──────────────────────────────┐        │ │
│  │        │     SQLite (local DB)        │        │ │
│  │        └──────────────────────────────┘        │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─ BROADCAST ────────────────────────────────────┐ │
│  │  TV  ●══▶ ┐                                    │ │
│  │           ├──▶ channel events                  │ │
│  │  RADIO ●══▶ ┘                                  │ │
│  └────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
          ┌────────────────┐
          │ mcp-server.ts  │
          │  (MCP/stdio)   │──────▶  Claude Code
          │                │  tools / channels
          └────────────────┘

tunr send ──────────────────────▶  channel event
  (one-shot, AX API)
```

### Components

| File | Description |
|------|-------------|
| `daemon.tsx` | TUI daemon (Ink/React). Polls windows, manages permissions, records to SQLite, manages audio capture |
| `mcp-server.ts` | MCP server. Provides search/history tools and channel event polling |
| `cli.ts` | CLI entry point (`watch`, `mcp`, `send`, `--version`) |
| `ax_text.swift` | Accessibility API text extractor. `--all` returns all windows as JSON. Uses AppleScript JS for Chrome web content |
| `send.swift` | One-shot screen capture. Writes channel event JSON |
| `embed.swift` | NLEmbedding (macOS NaturalLanguage framework) for 512-dim sentence embeddings used in vector search |
| `audio_capture.swift` | System audio capture via AVFoundation + BlackHole. Records WAV chunks at 16kHz mono |

### Data storage

All data is stored locally at `~/Library/Application Support/tunr/`:

- `tunr.db` — SQLite database with screen states and audio transcripts
- `audio/` — Audio WAV chunks (auto-cleaned after 24h)

## License

MIT
