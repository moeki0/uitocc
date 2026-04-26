# tunr

Screen context provider for Claude Code via MCP channels.

## Dev

```bash
bun install
swiftc swift/ax_text.swift -o tunr-ax-text -O
swiftc swift/send.swift -o tunr-send -O
bun src/daemon.tsx    # tunr start — TUI daemon
```

## Architecture

- **src/daemon.tsx**: TUI daemon (Ink/React) — polls all windows, channel-based window grouping, records to SQLite
- **src/mcp-server.ts**: MCP server with subscribe/unsubscribe/list_channels + search tools, polls DB for new records and notifies subscribed channels
- **src/ingest.ts**: CLI handler for `tunr ingest` — reads stdin, generates embedding, writes to `ingested` table
- **src/cli.ts**: Entry point — dispatches `mcp`, `send`, `start`, `ingest` subcommands
- **src/lib/**: Shared TypeScript modules (capture, db, rules, types, constants)
- **swift/send.swift**: One-shot shortcut script, writes channel_event.json
- **swift/ax_text.swift**: AX API text extractor (`--all` for all windows as JSON), AppleScript JS for Chrome web content
- **swift/embed.swift**: Generates 512-dim sentence embeddings via macOS NaturalLanguage NLEmbedding

## Channels

Channel = unit of window grouping. Create channels in the TUI, then manually assign windows to channels in the SOURCES panel. Assigned = captured & recorded; unassigned = ignored. Claude Code subscribes with `subscribe(channel)`.

- Manual per-window channel assignment (toggle with Enter)
- One window can belong to multiple channels
- Events are only emitted for subscribed channels

## MCP Tools

- `list_channels()` — available channels + subscription status
- `subscribe(channel)` — subscribe to channel notifications
- `unsubscribe(channel)` — stop receiving from channel
- `search_screen_history(query, channel?, app?, minutes?, limit?)` — search screen and ingested text (vector similarity via NLEmbedding, LIKE fallback). Prefers diff-based matching for "what changed" queries. Ingested results excluded when app filter is set
- `recent_screens(channel?, app?, minutes?, limit?)` — recent screen states and ingested records
- `page_history(title, minutes?, limit?)` — change history of a page (initial capture + diffs over time)
- `recent_audio(channel?, minutes?, limit?)` — recent audio transcripts
- `search_audio(query, channel?, minutes?, limit?)` — search audio transcripts

## MCP Channel Events

- `user_send` — user pressed shortcut to share current screen
- `screen` — real-time screen content changes (subscribed channels)
- `audio` — real-time audio transcription (subscribed channels with audio enabled)
- `ingested` — new data piped via `tunr ingest` (subscribed channels)

When the user references something they were looking at or listening to, or screen/audio context would help understand their request, proactively use these tools.

## Release

1. Bump `version` in `package.json`
2. Commit, tag, and push
   ```bash
   git add -A
   git commit -m "v1.x.x: <summary>"
   git tag v1.x.x
   git push origin main --tags
   ```
3. Update Homebrew formula (`../homebrew-tunr/Formula/tunr.rb`)
   - Update `url` to new version
   - Update `sha256`: `curl -sL <tarball-url> | shasum -a 256`
   ```bash
   cd ../homebrew-tunr
   git add Formula/tunr.rb
   git commit -m "tunr 1.x.x"
   git push origin main
   ```
4. Create GitHub Release
   ```bash
   gh release create v1.x.x --title "v1.x.x" --notes "..."
   ```
