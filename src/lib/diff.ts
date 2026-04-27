// LCS-based line diff: returns the lines present in `newLines` but not part of
// the longest common subsequence with `oldLines`. Used to compute compact
// "what changed" snippets for channel notifications.
export function computeDiffLines(oldLines: string[], newLines: string[]): string[] {
  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const changed: string[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) { i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { changed.push(newLines[j - 1]); j--; }
    else { i--; }
  }
  changed.reverse();
  return changed;
}
