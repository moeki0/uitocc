import { join } from "path";
import { homedir } from "os";

export const DATA_DIR = process.env.TUNR_DATA_DIR || join(homedir(), "Library", "Application Support", "tunr");
export const DB_PATH = process.env.TUNR_DB_PATH || join(DATA_DIR, "tunr.db");
export const AUDIO_DIR = join(DATA_DIR, "audio");
export const SCREENSHOT_DIR = join(DATA_DIR, "screenshots");
export const SETTINGS_PATH = join(DATA_DIR, "settings.json");

export const VERSION = "1.19.0";
export const POLL_MS = 3000;
export const AUDIO_SOURCE_KEY = "audio:0";
export const MIC_SOURCE_KEY = "mic:0";
export const MIC_DIR = join(DATA_DIR, "mic");

// Load saved settings with validation
let _savedSettings: any = {};
try {
  if (await Bun.file(SETTINGS_PATH).exists()) {
    const raw = JSON.parse(await Bun.file(SETTINGS_PATH).text());
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      _savedSettings = raw;
      // Validate denyList structure
      if (Array.isArray(raw.denyList)) {
        _savedSettings.denyList = raw.denyList.filter(
          (r: any) => r && typeof r === "object" && (typeof r.app === "string" || typeof r.title === "string" || typeof r.url === "string")
        );
      } else {
        _savedSettings.denyList = [];
      }
    }
  }
} catch {}

export const savedSettings = _savedSettings;
export const savedAudioChunkSec = typeof _savedSettings.audioChunkSec === "number" ? _savedSettings.audioChunkSec : 10;
