import type { DenyRule } from "./types";

export function globMatch(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;

  if (!value.startsWith(parts[0])) return false;
  let pos = parts[0].length;

  for (let i = 1; i < parts.length - 1; i++) {
    const idx = value.indexOf(parts[i], pos);
    if (idx === -1) return false;
    pos = idx + parts[i].length;
  }

  const last = parts[parts.length - 1];
  return value.length - pos >= last.length && value.endsWith(last);
}

export function isDenied(denyRules: DenyRule[], app: string, title: string, urls: string[]): boolean {
  return denyRules.some(rule => {
    if (rule.app && !globMatch(rule.app, app)) return false;
    if (rule.title && !globMatch(rule.title, title)) return false;
    if (rule.url && !urls.some(u => globMatch(rule.url!, u))) return false;
    return !!(rule.app || rule.title || rule.url);
  });
}
