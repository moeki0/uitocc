#!/usr/bin/env bun
/**
 * uitocc audio daemon — Continuously records system audio from BlackHole
 * using ffmpeg in 30-second rotating segments.
 *
 * Prerequisites:
 *   brew install blackhole-2ch ffmpeg
 *   Set up Multi-Output Device in Audio MIDI Setup
 */

import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

const AUDIO_DIR = join(homedir(), "Library", "Application Support", "uitocc", "audio");
const SEGMENT_SECONDS = 30;
const SEGMENT_WRAP = 4; // keep ~2 minutes of audio

mkdirSync(AUDIO_DIR, { recursive: true });

// Find BlackHole device index
async function findBlackHoleIndex(): Promise<string> {
  const proc = Bun.spawn(["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const lines = stderr.split("\n");
  for (const line of lines) {
    const match = line.match(/\[(\d+)\]\s+BlackHole/i);
    if (match) return match[1];
  }
  throw new Error("BlackHole device not found. Install with: brew install blackhole-2ch");
}

const deviceIndex = await findBlackHoleIndex();
console.log(`Found BlackHole at device index: ${deviceIndex}`);

const segmentPattern = join(AUDIO_DIR, "segment-%02d.wav");

const ffmpeg = Bun.spawn([
  "ffmpeg", "-y",
  "-f", "avfoundation",
  "-i", `:${deviceIndex}`,
  "-ac", "1",
  "-ar", "16000",
  "-f", "segment",
  "-segment_time", String(SEGMENT_SECONDS),
  "-segment_wrap", String(SEGMENT_WRAP),
  "-reset_timestamps", "1",
  segmentPattern,
], {
  stderr: "pipe",
});

console.log(`Recording system audio to ${AUDIO_DIR} (${SEGMENT_SECONDS}s segments, ${SEGMENT_WRAP} max)`);

// Handle graceful shutdown
process.on("SIGINT", () => {
  ffmpeg.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  ffmpeg.kill();
  process.exit(0);
});

await ffmpeg.exited;
