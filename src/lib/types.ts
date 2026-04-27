export interface ChannelRow {
  id: number;
  name: string;
  include_audio: number;
  include_mic: number;
}

export interface WindowInfo {
  pid: number;
  window_index: number;
  app: string;
  title: string;
  texts: string[];
  urls?: string[];
  window_id: number;
}

export interface TrackedSource {
  pid: number;
  window_index: number;
  window_id: number;
  app: string;
  title: string;
  urls: string[];
  channels: string[];
  lastSeen: number;
  virtual?: boolean; // true for Audio source
}

export interface Capture {
  id: string;
  timestamp: string;
  type: "screen" | "audio" | "ingested";
  app: string;
  title: string;
  excerpt: string;
  fullText: string;
  channels: string[];
  durationSec?: number;
  meta?: string;
}

export interface DayCount {
  date: string;
  screen: number;
  audio: number;
  total: number;
}

export type View = "feed" | "settings" | "detail" | "calendar";
export interface DenyRule {
  app?: string;
  title?: string;
  url?: string;
}

export type SettingsTab = "general" | "channels" | "deny";
export type FocusArea = "sources" | "feed";
