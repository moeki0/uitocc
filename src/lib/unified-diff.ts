// Compact unified-diff style output: only changed lines (- / +) with @@ position headers.
// Used by mcp-server to send minimal "what changed" payloads to subscribed channels.
export function makeDiff(oldLines: string[], newLines: string[]): string {
  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops: { type: " " | "-" | "+"; text: string }[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: " ", text: oldLines[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "+", text: newLines[j - 1] }); j--;
    } else {
      ops.push({ type: "-", text: oldLines[i - 1] }); i--;
    }
  }
  ops.reverse();

  const changes = ops.filter(o => o.type !== " ");
  if (changes.length === 0) return "";

  const result: string[] = [];
  let lastHunkOldLine = -1;
  let oldLine = 1, newLine = 1;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type === " ") { oldLine++; newLine++; continue; }
    if (oldLine !== lastHunkOldLine + 1 || result.length === 0) {
      result.push(`@@ -${oldLine} +${newLine} @@`);
    }
    result.push(`${ops[k].type}${ops[k].text}`);
    if (ops[k].type === "-") { lastHunkOldLine = oldLine; oldLine++; }
    else { lastHunkOldLine = oldLine; newLine++; }
  }
  return result.join("\n");
}
