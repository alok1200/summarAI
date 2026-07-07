import { fetchTranscriptWithRetry, fetchVideoMeta } from "../src/lib/youtube-transcript.ts";

const VIDEO_ID = "s0jL3EKxt6I";
console.log("Video ID:", VIDEO_ID);
console.log("");

// First check meta (uses oEmbed - not bot-protected)
console.log("=== oEmbed metadata (no bot protection) ===");
try {
  const meta = await fetchVideoMeta(VIDEO_ID);
  console.log("✓", JSON.stringify(meta));
} catch (e) {
  console.log("✗", e.message);
}
console.log("");

// Try the full transcript fetch
console.log("=== Full transcript fetch (4-strategy fallback) ===");
try {
  const segments = await fetchTranscriptWithRetry(VIDEO_ID);
  console.log(`✓ Got ${segments.length} segments`);
  console.log("First 3 segments:");
  for (const s of segments.slice(0, 3)) {
    console.log(`  [${s.start.toFixed(1)}s] ${s.text}`);
  }
  console.log(`...total chars: ${segments.reduce((a, b) => a + b.text.length, 0)}`);
} catch (e) {
  console.log("✗ Error:", e.message);
  console.log("  Code:", e.code || "(none)");
}
