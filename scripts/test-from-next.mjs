// Simulate what happens inside Next.js
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

const COMPANION_HOST = "inv-de1.nadeko.net";
const VIDEO_ID = "s0jL3EKxt6I";
const checkId = "osmJaNjhraThjxMWv2hDZSVpe4cKF2o70RFXCwGjnxs";

const url = `https://${COMPANION_HOST}/companion/api/v1/captions/${VIDEO_ID}?check=${encodeURIComponent(checkId)}`;
console.log("Fetching:", url);

// Try with native fetch (what Next.js uses)
try {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  console.log("Status:", r.status);
  const t = await r.text();
  console.log("Body:", t.slice(0, 200));
} catch (e) {
  console.log("Error type:", e.constructor.name);
  console.log("Error message:", e.message);
  if (e.cause) {
    console.log("Cause type:", e.cause.constructor?.name);
    console.log("Cause message:", e.cause.message);
    console.log("Cause code:", e.cause.code);
  }
}

// Now try with explicit https module
console.log("\n--- Try with node:https directly ---");
import https from "node:https";

const url2 = new URL(url);
const options = {
  hostname: url2.hostname,
  port: 443,
  path: url2.pathname + url2.search,
  method: "GET",
  headers: { "User-Agent": "Mozilla/5.0" },
  family: 4,  // Force IPv4
  timeout: 15000,
};

await new Promise((resolve) => {
  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (c) => data += c);
    res.on("end", () => {
      console.log("Status:", res.statusCode);
      console.log("Body:", data.slice(0, 200));
      resolve();
    });
  });
  req.on("error", (e) => {
    console.log("Error:", e.message);
    console.log("Code:", e.code);
    resolve();
  });
  req.on("timeout", () => {
    console.log("Timeout!");
    req.destroy();
    resolve();
  });
  req.end();
});
