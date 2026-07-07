import { fetchTranscriptWithRetry } from "../src/lib/youtube-transcript.ts";

const VIDEO_ID = "s0jL3EKxt6I";
console.log("Retry after 60s cooldown...");
try {
  const segments = await fetchTranscriptWithRetry(VIDEO_ID);
  console.log(`✓ Got ${segments.length} segments!`);
  console.log(`Total chars: ${segments.reduce((a, b) => a + b.text.length, 0)}`);
  console.log("First 5 segments:");
  for (const s of segments.slice(0, 5)) {
    console.log(`  [${s.start.toFixed(1)}s] ${s.text}`);
  }
} catch (e) {
  console.log("✗ Still blocked:", e.message);
  console.log("Code:", e.code);
}
