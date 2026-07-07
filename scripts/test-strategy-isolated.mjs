// Run the actual Invidious strategy in isolation to see what fails
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const INVIDIOUS_HOST = "inv.nadeko.net";
const COMPANION_HOST = "inv-de1.nadeko.net";
const VIDEO_ID = "s0jL3EKxt6I";

console.log("Step 1: Fetch Invidious watch page via r.jina.ai...");
let watchHtml;
try {
  const r = await fetch(`https://r.jina.ai/https://${INVIDIOUS_HOST}/watch?v=${VIDEO_ID}`, {
    headers: { "Accept": "text/plain" },
    signal: AbortSignal.timeout(30000),
  });
  console.log("  Status:", r.status);
  watchHtml = await r.text();
  console.log("  Length:", watchHtml.length);
} catch (e) {
  console.log("  FAILED:", e.message);
  if (e.cause) console.log("  Cause:", e.cause.message ?? e.cause);
  process.exit(1);
}

console.log("\nStep 2: Extract check ID...");
const m = watchHtml.match(/check=([a-zA-Z0-9_-]+)/);
if (!m) {
  console.log("  No check ID found");
  process.exit(1);
}
const checkId = m[1];
console.log("  Check ID:", checkId);

console.log("\nStep 3: List captions via companion API...");
const captionsUrl = `https://${COMPANION_HOST}/companion/api/v1/captions/${VIDEO_ID}?check=${encodeURIComponent(checkId)}`;
console.log("  URL:", captionsUrl);
try {
  const r = await fetch(captionsUrl, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  console.log("  Status:", r.status);
  const t = await r.text();
  console.log("  Body:", t.slice(0, 300));
} catch (e) {
  console.log("  FAILED:", e.message);
  if (e.cause) console.log("  Cause:", e.cause.message ?? e.cause);
}

console.log("\nStep 4: Fetch VTT caption content...");
const capUrl = `https://${COMPANION_HOST}/companion/api/v1/captions/${VIDEO_ID}?label=Hindi%20(auto-generated)&check=${encodeURIComponent(checkId)}&fmt=vtt`;
console.log("  URL:", capUrl);
try {
  const r = await fetch(capUrl, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  console.log("  Status:", r.status);
  const t = await r.text();
  console.log("  Length:", t.length);
  console.log("  First 200 chars:", t.slice(0, 200));
} catch (e) {
  console.log("  FAILED:", e.message);
  if (e.cause) console.log("  Cause:", e.cause.message ?? e.cause);
}
