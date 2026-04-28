# tunr onboarding for Claude Code

This is a runbook for **Claude Code** to install and onboard a user onto tunr from zero. Follow steps in order. Stop and ask the user when a step requires GUI interaction or permission grants you cannot perform.

Audience: Claude Code (the CLI agent). The user's role is to grant permissions and confirm choices.

---

## 0. Prerequisites check

Run these and report what's present:

```bash
sw_vers -productVersion        # macOS — tunr is macOS-only
which brew                     # Homebrew required
which claude                   # Claude Code CLI required
```

If `brew` or `claude` is missing, stop and ask the user to install them first.

## 1. Install tunr

```bash
brew install moeki0/tunr/tunr
tunr --version
```

## 2. Grant Accessibility permission

tunr reads window text via the macOS Accessibility API. The terminal app running tunr (Terminal, iTerm, Ghostty, etc.) needs Accessibility access.

**You cannot grant this for the user.** Tell them:

> Open **System Settings → Privacy & Security → Accessibility** and enable your terminal app. If tunr was already running, restart it after granting.

Verify by running `tunr start --foreground` briefly and checking that `tunr sources` lists windows. If it returns empty, permission is missing.

## 3. (Optional) Chrome web content

Ask the user if they want Chrome **page text** captured (not just tab titles). If yes:

```bash
defaults write com.google.Chrome AllowJavaScriptAppleEvents -bool true
```

Mention the security tradeoff (any app with Automation permission can run JS in Chrome tabs). Skip if the user is unsure.

## 4. Register the MCP server with Claude Code

```bash
claude mcp add -s user tunr -- tunr mcp
claude mcp list | grep tunr
```

Tell the user that **future** `claude` sessions must be launched with the channel flag for real-time streaming:

```bash
claude --dangerously-load-development-channels server:tunr
```

The flag name is alarming but only enables the MCP channel protocol — it is not a security downgrade. Suggest aliasing it.

## 5. Start the daemon

```bash
tunr start
tunr status
```

If the daemon fails to start, read `~/Library/Application Support/tunr/tunr.log`.

## 6. Create a channel and assign windows

Ask the user what they want to capture (e.g. `dev`, `research`, `Hobby`). Then:

```bash
tunr channels add <name>
tunr sources           # list live windows with their keys
tunr sources assign <window-key> <name>
```

If `fzf` is installed, offer the interactive picker:

```bash
tunr sources | fzf -m | awk '{print $1}' | xargs -n1 -I{} tunr sources assign {} <name>
```

Remind them: source assignments are **ephemeral** — they may need re-assigning after restart.

## 7. (Optional) Deny list

Ask whether there are apps/sites that must never be captured (password managers, private mail, banking). Add them:

```bash
tunr deny add --app 1Password
tunr deny add --url '*mail.google.com*'
tunr deny
```

Deny rules override channel assignments.

## 8. (Optional) Audio capture

Skip unless the user explicitly wants audio. If yes, walk them through README §Audio setup:

1. `brew install --cask blackhole-2ch`
2. **GUI step (user does this):** Audio MIDI Setup → create Multi-Output Device → check speakers + BlackHole 2ch → set as system output.
3. Download the whisper model and install whisper-cpp:
   ```bash
   curl -L -o ~/.cache/whisper-cpp-small.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
   brew install whisper-cpp
   ```

Restart `tunr` after audio setup.

## 9. (Optional) Plugin for slash commands

```bash
/plugin marketplace add moeki0/tunr-skill
/plugin install tunr@tunr
```

Gives the user `/tunr:subscribe`, `/tunr:unsubscribe`, `/tunr:pause`, `/tunr:resume`.

## 10. Verify end-to-end

In a fresh Claude Code session launched with `--dangerously-load-development-channels server:tunr`:

1. Call `list_channels()` — confirm the channel exists.
2. Call `subscribe("<name>")`.
3. Have the user focus an assigned window and change its content. Confirm a `screen` channel event arrives.
4. Call `recent_screens(channel: "<name>")` and confirm rows are returned.

If no events arrive: check `tunr status`, check that the window is assigned (`tunr sources`), check the log (`tunr log -f`).

---

## Troubleshooting cheat sheet

| Symptom | Check |
|---------|-------|
| `tunr sources` empty | Accessibility permission on terminal app |
| Chrome shows only titles | `defaults read com.google.Chrome AllowJavaScriptAppleEvents` |
| MCP tools missing in Claude Code | `claude mcp list`; relaunch with `--dangerously-load-development-channels server:tunr` |
| No channel events | Daemon running? Window assigned? Subscribed in this session? |
| Audio silent | Multi-Output Device selected as system output; whisper model present at `~/.cache/whisper-cpp-small.bin` |
| Daemon won't start | `~/Library/Application Support/tunr/tunr.log` |

## Data locations

- DB & settings: `~/Library/Application Support/tunr/`
- PID / log: `<DATA_DIR>/tunr.pid`, `<DATA_DIR>/tunr.log`
- Screenshots (when `tunr capture --image`): `<DATA_DIR>/screenshots/`
