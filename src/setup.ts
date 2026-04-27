import { join, dirname } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

const BIN_DIR = dirname(process.execPath);
const PROJECT_DIR = join(import.meta.dir, "..");

function binPath(name: string): string {
  const fromBin = join(BIN_DIR, name);
  const fromProject = join(PROJECT_DIR, name);
  return existsSync(fromBin) ? fromBin : fromProject;
}

function ok(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m  ${msg}`);
}

function info(msg: string) {
  console.log(`  \x1b[2m→\x1b[0m  ${msg}`);
}

function step(msg: string) {
  console.log(`\n\x1b[1m${msg}\x1b[0m`);
}

// Check Accessibility permission
function hasAccessibility(): boolean {
  const bin = binPath("tunr-ax-text");
  if (!existsSync(bin)) return false;
  try {
    const proc = Bun.spawnSync([bin, "--all"], { stderr: "pipe", timeout: 3000 });
    if (proc.exitCode !== 0) return false;
    return proc.stdout.toString().trim().startsWith("[");
  } catch {
    return false;
  }
}

// Check MCP registration
function hasMcp(): boolean {
  try {
    const proc = Bun.spawnSync(["claude", "mcp", "list"], { stderr: "pipe", timeout: 5000 });
    return proc.exitCode === 0 && proc.stdout.toString().includes("tunr");
  } catch {
    return false;
  }
}

// Register MCP
function registerMcp(): boolean {
  try {
    const proc = Bun.spawnSync(
      ["claude", "mcp", "add", "-s", "user", "tunr", "--", "tunr", "mcp"],
      { stdout: "inherit", stderr: "inherit" }
    );
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

// Open Accessibility system settings
function openAccessibilitySettings() {
  Bun.spawnSync([
    "open",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  ]);
}

export async function runSetup(args: string[]) {
  const audioMode = args.includes("--audio");

  console.log("\ntunr setup\n");

  // --- Accessibility ---
  step("Accessibility");
  if (hasAccessibility()) {
    ok("Accessibility permission already granted");
  } else {
    console.log("  \x1b[33m!\x1b[0m  Accessibility permission required");
    info("Opening System Settings > Privacy & Security > Accessibility...");
    openAccessibilitySettings();
    info("Grant access to your terminal app, then re-run `tunr setup`");
    console.log();
    return;
  }

  // --- MCP ---
  step("MCP server");
  if (hasMcp()) {
    ok("MCP server already registered");
  } else {
    info("Registering MCP server with Claude Code...");
    if (registerMcp()) {
      ok("MCP server registered");
    } else {
      console.log("  \x1b[31m✗\x1b[0m  Failed to register MCP server");
      info("Run manually: claude mcp add -s user tunr -- tunr mcp");
    }
  }

  // --- Chrome (optional) ---
  step("Chrome (optional)");
  const chromeProc = Bun.spawnSync(
    ["defaults", "read", "com.google.Chrome", "AllowJavaScriptAppleEvents"],
    { stderr: "pipe" }
  );
  const chromeEnabled = chromeProc.exitCode === 0 && chromeProc.stdout.toString().trim() === "1";
  if (chromeEnabled) {
    ok("Chrome AppleScript already enabled");
  } else {
    info("To capture web page text from Chrome, run:");
    info("  defaults write com.google.Chrome AllowJavaScriptAppleEvents -bool true");
  }

  // --- Audio (optional, --audio flag) ---
  if (audioMode) {
    step("Audio setup");

    // BlackHole
    const bhProc = Bun.spawnSync(
      ["system_profiler", "-json", "SPAudioDataType"],
      { stderr: "pipe", timeout: 5000 }
    );
    let hasBlackhole = false;
    if (bhProc.exitCode === 0) {
      const data = JSON.parse(bhProc.stdout.toString());
      hasBlackhole = JSON.stringify(data?.SPAudioDataType ?? [])
        .toLowerCase()
        .includes("blackhole");
    }

    if (hasBlackhole) {
      ok("BlackHole detected");
    } else {
      console.log("  \x1b[33m!\x1b[0m  BlackHole not detected");
      info("Install BlackHole: brew install --cask blackhole-2ch");
      info("Then open Audio MIDI Setup and create a Multi-Output Device");
      info("with both your speakers and BlackHole 2ch checked,");
      info("and set it as your system output.");
    }

    // whisper-cpp
    const whisperBin = Bun.spawnSync(["which", "whisper-cli"], { stderr: "pipe" });
    if (whisperBin.exitCode === 0) {
      ok("whisper-cpp installed");
    } else {
      console.log("  \x1b[33m!\x1b[0m  whisper-cpp not found");
      info("Install: brew install whisper-cpp");
    }

    // whisper model
    const modelPath = join(homedir(), ".cache", "whisper-cpp-small.bin");
    if (existsSync(modelPath)) {
      ok("Whisper model found");
    } else {
      console.log("  \x1b[33m!\x1b[0m  Whisper model not found");
      info("Download: curl -L -o ~/.cache/whisper-cpp-small.bin \\");
      info("  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin");
    }
  } else {
    console.log("\n  \x1b[2mFor audio setup, run: tunr setup --audio\x1b[0m");
  }

  console.log("\n\x1b[32mDone.\x1b[0m Run `tunr doctor` to verify your setup.\n");
}
