# uitocc

Screen context provider for Claude Code via MCP channels.

## Dev

```bash
bun install
swiftc ax_text.swift -o ax_text -O
swiftc send.swift -o send -O
bun daemon.ts    # start observer
```

## Architecture

- **daemon.ts**: Polls screen via ax_text, writes actions + screen_states to SQLite
- **mcp-server.ts**: MCP server, reads DB, pushes channel notifications
- **send.swift**: One-shot shortcut script, writes channel_event.json (includes audio transcription if available)
- **ax_text.swift**: AX API text extractor
- **audio-daemon.ts**: Continuously records system audio from BlackHole via ffmpeg (30s rotating segments)
- **transcribe.swift**: Transcribes recent audio segments using SFSpeechRecognizer

## Dedup rules

- navigation / app_switch: deduplicated by normalized app+title (session lifetime)
- content_change: 10s cooldown, always passes dedup
- user_send: always passes
