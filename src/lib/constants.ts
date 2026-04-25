import { join } from "path";
import { homedir } from "os";

export const DATA_DIR = join(homedir(), "Library", "Application Support", "tunr");
export const DB_PATH = join(DATA_DIR, "tunr.db");
export const AUDIO_DIR = join(DATA_DIR, "audio");
export const SETTINGS_PATH = join(DATA_DIR, "settings.json");

export const VERSION = "1.7.1";
export const POLL_MS = 3000;
export const AUDIO_SOURCE_KEY = "audio:0";

// Load saved settings
let _savedSettings: any = {};
try {
  if (await Bun.file(SETTINGS_PATH).exists()) {
    _savedSettings = JSON.parse(await Bun.file(SETTINGS_PATH).text());
  }
} catch {}

export const savedSettings = _savedSettings;
export const savedAudioChunkSec = typeof _savedSettings.audioChunkSec === "number" ? _savedSettings.audioChunkSec : 10;
