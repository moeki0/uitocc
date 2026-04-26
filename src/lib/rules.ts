import type { ChannelRow } from "./types";
import { db } from "./db";

export function getChannels(): ChannelRow[] {
  return db.prepare(`SELECT id, name, include_audio FROM channels ORDER BY id`).all() as any[];
}

export function getActiveSubscriptions(): string[] {
  return (db.prepare(`SELECT channel_name FROM channel_subscriptions`).all() as any[]).map(r => r.channel_name);
}
