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

function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "✓" : "✗";
  const color = ok ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";
  const suffix = detail ? `  ${"\x1b[2m"}${detail}${reset}` : "";
  console.log(`  ${color}${mark}${reset}  ${label}${suffix}`);
  return ok;
}

function warn(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "✓" : "!";
  const color = ok ? "\x1b[32m" : "\x1b[33m";
  const reset = "\x1b[0m";
  const suffix = detail ? `  ${"\x1b[2m"}${detail}${reset}` : "";
  console.log(`  ${color}${mark}${reset}  ${label}${suffix}`);
  return ok;
}

// Check if a binary exists
function checkBinary(name: string): boolean {
  const p = binPath(name);
  return existsSync(p);
}

// Check Accessibility permission by running tunr-ax-text
function checkAccessibility(): boolean {
  const bin = binPath("tunr-ax-text");
  if (!existsSync(bin)) return false;
  try {
    const proc = Bun.spawnSync([bin, "--all"], { stderr: "pipe", timeout: 3000 });
    if (proc.exitCode !== 0) return false;
    const out = proc.stdout.toString().trim();
    return out.startsWith("[");
  } catch {
    return false;
  }
}

// Check MCP registration via `claude mcp list`
function checkMcp(): boolean {
  try {
    const proc = Bun.spawnSync(["claude", "mcp", "list"], { stderr: "pipe", timeout: 5000 });
    if (proc.exitCode !== 0) return false;
    return proc.stdout.toString().includes("tunr");
  } catch {
    return false;
  }
}

// Check Chrome AppleScript setting
function checkChrome(): boolean {
  try {
    const proc = Bun.spawnSync(
      ["defaults", "read", "com.google.Chrome", "AllowJavaScriptAppleEvents"],
      { stderr: "pipe" }
    );
    return proc.exitCode === 0 && proc.stdout.toString().trim() === "1";
  } catch {
    return false;
  }
}

// Check BlackHole audio device
function checkBlackhole(): boolean {
  try {
    const proc = Bun.spawnSync(
      ["system_profiler", "-json", "SPAudioDataType"],
      { stderr: "pipe", timeout: 5000 }
    );
    if (proc.exitCode !== 0) return false;
    const data = JSON.parse(proc.stdout.toString());
    const devices: any[] = data?.SPAudioDataType ?? [];
    return devices.some((d: any) =>
      JSON.stringify(d).toLowerCase().includes("blackhole")
    );
  } catch {
    return false;
  }
}

// Check whisper model
function checkWhisperModel(): boolean {
  const modelPath = join(homedir(), ".cache", "whisper-cpp-small.bin");
  return existsSync(modelPath);
}

// Check whisper-cpp binary
function checkWhisperBin(): boolean {
  try {
    const proc = Bun.spawnSync(["which", "whisper-cli"], { stderr: "pipe" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

// Check daemon running
function checkDaemon(): boolean {
  try {
    const proc = Bun.spawnSync(["pgrep", "-f", "tunr start"], { stderr: "pipe" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function runDoctor() {
  console.log("\ntunr doctor\n");

  console.log("Core");
  const hasTunrAxText = check("tunr-ax-text binary", checkBinary("tunr-ax-text"));
  check("tunr-send binary", checkBinary("tunr-send"));
  check("tunr-embed binary", checkBinary("tunr-embed"));
  check("tunr-event-monitor binary", checkBinary("tunr-event-monitor"));

  console.log("\nPermissions");
  const hasAx = hasTunrAxText
    ? check("Accessibility permission", checkAccessibility(), "required for screen capture")
    : check("Accessibility permission", false, "tunr-ax-text not found, cannot check");

  console.log("\nSetup");
  check("MCP server registered", checkMcp(), "claude mcp add -s user tunr -- tunr mcp");
  check("Daemon running", checkDaemon(), "tunr start");

  console.log("\nOptional — Chrome");
  warn("Chrome AppleScript enabled", checkChrome(), "for web page text capture");

  console.log("\nOptional — Audio");
  const hasBh = warn("BlackHole installed", checkBlackhole(), "brew install --cask blackhole-2ch");
  const hasWb = warn("whisper-cpp installed", checkWhisperBin(), "brew install whisper-cpp");
  const hasWm = warn(
    "whisper model downloaded",
    checkWhisperModel(),
    "~/.cache/whisper-cpp-small.bin"
  );
  check("tunr-audio-capture binary", checkBinary("tunr-audio-capture"));

  console.log();

  const issues: string[] = [];
  if (!hasAx) issues.push("run `tunr setup` to fix permissions and registration");
  if (!hasBh || !hasWb || !hasWm) issues.push("run `tunr setup --audio` for audio setup instructions");

  if (issues.length > 0) {
    for (const i of issues) console.log(`  \x1b[2m→ ${i}\x1b[0m`);
    console.log();
  }
}
