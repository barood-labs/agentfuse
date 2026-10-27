/** Small line diff. Files in a forge run are tiny; O(n*m) LCS is enough. */
export function unifiedDiff(filePath: string, before: string, after: string): string {
  const left = splitLines(before);
  const right = splitLines(after);
  const lcs = longestCommon(left, right);
  const body: string[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && k < lcs.length && left[i] === lcs[k] && right[j] === lcs[k]) {
      body.push(` ${left[i]}`);
      i++;
      j++;
      k++;
    } else if (i < left.length && (k >= lcs.length || left[i] !== lcs[k])) {
      body.push(`-${left[i]}`);
      i++;
    } else if (j < right.length) {
      body.push(`+${right[j]}`);
      j++;
    }
  }
  const oldCount = body.filter((line) => !line.startsWith("+")).length;
  const newCount = body.filter((line) => !line.startsWith("-")).length;
  const oldStart = oldCount === 0 ? 0 : 1;
  const newStart = newCount === 0 ? 0 : 1;
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...body,
  ].join("\n");
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
  return lines;
}

function longestCommon(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}
