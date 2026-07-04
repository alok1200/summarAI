/**
 * verify-time-parsing.mjs
 *
 * Confirms the new time-input parsing rules:
 *   - Bare number  → MINUTES     ("5" = 5 min = 300 s)
 *   - "M:SS"        → unchanged   ("5:30" = 330 s)
 *   - "H:MM:SS"     → unchanged   ("1:25:30" = 5130 s)
 *   - "5m"          → 5 minutes  (explicit unit)
 *   - "90s"         → 90 seconds (explicit unit)
 *   - "1h"          → 1 hour     (explicit unit)
 *   - "1h30m"       → 1h30m      (composite)
 *   - "2h15m30s"    → 2h15m30s   (composite)
 *   - Empty / garbage → undefined
 *
 * Run with:  node scripts/verify-time-parsing.mjs
 */

// Re-implement parseTimeString here (it's in TS src, can't import directly from .mjs).
// Keep in sync with src/lib/youtube-transcript.ts.
function parseTimeString(s) {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  if (/[hms]/i.test(trimmed) && /^[\d\s.:hms]+$/i.test(trimmed)) {
    const h = trimmed.match(/(\d+)\s*h/i);
    const m = trimmed.match(/(\d+)\s*m/i);
    const sec = trimmed.match(/(\d+)\s*s/i);
    if (h || m || sec) {
      let total = 0;
      if (h) total += parseInt(h[1], 10) * 3600;
      if (m) total += parseInt(m[1], 10) * 60;
      if (sec) total += parseInt(sec[1], 10);
      return total;
    }
  }
  const parts = trimmed.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n))) return undefined;
  if (parts.length === 1) return parts[0] * 60; // ← bare = MINUTES
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

const cases = [
  // [input, expectedSeconds, label]
  ["5",       300,   "bare number → 5 minutes (NEW BEHAVIOUR)"],
  ["1",       60,    "bare 1 → 1 minute"],
  ["0",       0,     "bare 0 → 0 minutes (video start)"],
  ["90",      5400,  "bare 90 → 90 minutes (1.5 hours)"],
  ["5:30",    330,   "M:SS unchanged"],
  ["0:30",    30,    "0:30 = 30 seconds (M:SS form)"],
  ["12:08",   728,   "MM:SS"],
  ["1:25:30", 5130,  "H:MM:SS unchanged"],
  ["2:05:14", 7514,  "H:MM:SS"],
  ["5m",      300,   "5m = 5 minutes (explicit unit)"],
  ["5M",      300,   "5M (case-insensitive)"],
  ["90s",     90,    "90s = 90 seconds (explicit unit)"],
  ["1h",      3600,  "1h = 1 hour"],
  ["1h30m",   5400,  "1h30m = 1 hour 30 min"],
  ["2h15m30s", 8130, "2h15m30s composite"],
  ["1h 30m",  5400,  "1h 30m with space"],
  ["  5  ",   300,   "whitespace trimmed"],
  ["",        undefined, "empty → undefined"],
  ["abc",     undefined, "garbage → undefined"],
  ["5:abc",   undefined, "garbage after colon → undefined"],
];

let passed = 0;
let failed = 0;
for (const [input, expected, label] of cases) {
  const actual = parseTimeString(input);
  if (actual === expected) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label.padEnd(50)}  input=${JSON.stringify(input)} → ${actual}s`);
  } else {
    failed++;
    console.error(`  \x1b[31m✗\x1b[0m ${label}`);
    console.error(`     input=${JSON.stringify(input)}  expected=${expected}  got=${actual}`);
  }
}

console.log(`\n────────────────────────────────────────`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`────────────────────────────────────────`);
process.exit(failed > 0 ? 1 : 0);
