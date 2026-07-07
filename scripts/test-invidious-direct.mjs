import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

console.log("Test 1: Direct fetch to inv-de1.nadeko.net...");
try {
  const r = await fetch("https://inv-de1.nadeko.net/companion/api/v1/captions/s0jL3EKxt6I?check=osmJaNjhraThjxMWv2hDZSVpe4cKF2o70RFXCwGjnxs%3D", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  console.log("Status:", r.status);
  const t = await r.text();
  console.log("Body:", t.slice(0, 200));
} catch (e) {
  console.log("Error:", e.message);
  if (e.cause) console.log("Cause:", e.cause.message ?? e.cause);
}

console.log("\nTest 2: fetch inv.nadeko.net/watch page...");
try {
  const r = await fetch("https://inv.nadeko.net/watch?v=s0jL3EKxt6I", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  console.log("Status:", r.status);
  const t = await r.text();
  console.log("Body length:", t.length);
  console.log("First 200 chars:", t.slice(0, 200));
} catch (e) {
  console.log("Error:", e.message);
  if (e.cause) console.log("Cause:", e.cause.message ?? e.cause);
}

console.log("\nTest 3: fetch via r.jina.ai (proxy)...");
try {
  const r = await fetch("https://r.jina.ai/https://inv.nadeko.net/watch?v=s0jL3EKxt6I", {
    headers: { "Accept": "text/plain" },
    signal: AbortSignal.timeout(30000),
  });
  console.log("Status:", r.status);
  const t = await r.text();
  console.log("Body length:", t.length);
  console.log("Has 'check=':", t.includes("check="));
  if (t.includes("check=")) {
    const m = t.match(/check=([a-zA-Z0-9_-]+)/);
    console.log("Check ID:", m?.[1]);
  }
} catch (e) {
  console.log("Error:", e.message);
  if (e.cause) console.log("Cause:", e.cause.message ?? e.cause);
}
