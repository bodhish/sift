// Added (new-side) line numbers of a unified patch body.
export function parsePatch(text) {
  const addedLines = [];
  let newNo = 0;
  for (const raw of (text || "").split("\n")) {
    const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      newNo = Number(m[1]);
      continue;
    }
    if (raw.startsWith("+")) addedLines.push(newNo++);
    else if (raw.startsWith("-") || raw.startsWith("\\")) continue;
    else newNo++;
  }
  return { addedLines };
}
