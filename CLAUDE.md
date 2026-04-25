# tunr

Screen context provider for Claude Code via MCP channels.

## Dev

```bash
bun install
swiftc ax_text.swift -o tunr-ax-text -O
swiftc send.swift -o tunr-send -O
bun daemon.tsx    # start watch daemon with TUI
```

## Architecture

- **daemon.tsx**: TUI daemon (Ink/React) — polls all windows via ax_text, asks per-window permission, records allowed windows to SQLite
- **mcp-server.ts**: MCP server with search_screen_history / recent_screens tools, plus channel notifications for user_send
- **send.swift**: One-shot shortcut script, writes channel_event.json
- **ax_text.swift**: AX API text extractor (`--all` for all windows as JSON)
- **embed.swift**: NLEmbedding (macOS NaturalLanguage) で512次元センテンス埋め込みを生成

## MCP Tools

- `search_screen_history(query, minutes?, limit?)` — search observed screen text (vector similarity via NLEmbedding, LIKE fallback)
- `recent_screens(minutes?, limit?)` — recent screen states
- `recent_audio(minutes?, limit?)` — recent audio transcripts
- `search_audio(query, minutes?, limit?)` — search audio transcripts

## MCP Channels

- `user_send` — user pressed shortcut to share current screen
- `audio_transcript` — real-time audio transcription (every 10s)

When the user references something they were looking at or listening to, or screen/audio context would help understand their request, proactively use these tools.

## Dedup rules

- navigation / app_switch: deduplicated by normalized app+title (session lifetime)
- content_change: 10s cooldown, always passes dedup
- user_send: always passes
