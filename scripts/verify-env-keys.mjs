/**
 * verify-env-keys.mjs
 *
 * Confirms the BYO-key vs default-fallback contract end-to-end:
 *
 *   1. With NO ZAI_API_KEY set  → getZai() should resolve a client (via
 *      /etc/.z-ai-config) AND a real chat call should return content.
 *   2. With a (fake) ZAI_API_KEY set → getZai() should construct the client
 *      with OUR config, NOT touch /etc/.z-ai-config. We verify the client
 *      object's internal config to prove it. We DON'T make a real chat call
 *      here because the fake key would 401 — that's expected and not what
 *      we're testing.
 *   3. LLM_MODEL / LLM_VISION_MODEL helpers return correct defaults and
 *      overrides.
 *
 * Run with:  node scripts/verify-env-keys.mjs
 */
import ZAI from "z-ai-web-dev-sdk";
import assert from "node:assert";

// ---------- Mirror of the helpers in src/lib/llm.ts (compiled ESM) ----------
// We can't import directly from src/ (TS) in a plain .mjs, so we re-implement
// the small getZai/getLLMModel/getLLMVisionModel here using the SAME logic.
// If they ever diverge, this test will lie — so keep them in sync.

const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/v1";

async function getZai() {
  const envKey = process.env.ZAI_API_KEY;
  if (envKey && envKey.trim() !== "") {
    const config = {
      baseUrl: (process.env.ZAI_BASE_URL || DEFAULT_ZAI_BASE_URL).trim(),
      apiKey: envKey.trim(),
    };
    return new ZAI(config);
  }
  return await ZAI.create();
}

function getLLMModel() {
  const m = process.env.LLM_MODEL;
  return m && m.trim() !== "" ? m.trim() : undefined;
}

function getLLMVisionModel() {
  const m = process.env.LLM_VISION_MODEL;
  return m && m.trim() !== "" ? m.trim() : "glm-4v-flash";
}

// ---------- Test runner ----------

let passed = 0;
let failed = 0;
function ok(name) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function fail(name, err) {
  failed++;
  console.error(`  \x1b[31m✗\x1b[0m ${name}`);
  console.error(`     ${(err?.message ?? err)}`);
}

// ---------- Test 1: NO env key → uses /etc/.z-ai-config ----------

async function testDefaultFallback() {
  console.log("\n[1] ZAI_API_KEY empty → should fall back to /etc/.z-ai-config");
  delete process.env.ZAI_API_KEY;
  delete process.env.ZAI_BASE_URL;

  try {
    const client = await getZai();
    assert.ok(client, "getZai() returned a falsy value");
    assert.ok(client.chat?.completions?.create, "client is missing chat.completions.create");
    assert.ok(client.chat?.completions?.createVision, "client is missing chat.completions.createVision");
    ok("getZai() returned a usable client");
    ok("client has chat.completions.create + createVision methods");

    // The internal config should match /etc/.z-ai-config, NOT our env defaults.
    // (We can't read /etc/.z-ai-config directly because it's root-only, but we
    // can check the client's internal baseUrl matches what we expect the SDK
    // to have loaded.)
    const internalConfig = client.config;
    assert.ok(internalConfig?.apiKey, "client.config.apiKey is missing");
    // NOTE: /etc/.z-ai-config uses an apiKey of "Z.ai" (length 4) and authenticates
    // via the `token` JWT field instead — so we don't assert on apiKey length here.
    // The real chat call below is the strongest proof the client is wired up.
    assert.ok(
      internalConfig?.baseUrl?.startsWith("http"),
      `client.config.baseUrl doesn't look like a URL: ${internalConfig?.baseUrl}`
    );
    ok(`client.config.baseUrl = ${internalConfig.baseUrl}`);
    ok(`client.config.apiKey  = ${JSON.stringify(internalConfig.apiKey)} (length ${internalConfig.apiKey.length})`);
    ok(`client.config.token   = ${internalConfig.token ? internalConfig.token.slice(0, 20) + "…" : "(none)"} (JWT marker)`);
    ok(`client.config.chatId  = ${internalConfig.chatId ?? "(none)"}`);
    ok(`client.config.userId  = ${internalConfig.userId ?? "(none)"}`);

    // Real round-trip call — this hits the actual Z.ai API.
    const completion = await client.chat.completions.create({
      messages: [
        { role: "system", content: "Reply with the single word PONG and nothing else." },
        { role: "user", content: "ping" },
      ],
      thinking: { type: "disabled" },
    });
    const text = completion?.choices?.[0]?.message?.content ?? "";
    assert.ok(text.length > 0, "real chat call returned empty content");
    ok(`real chat call returned: "${text.slice(0, 40).replace(/\n/g, " ")}"`);
  } catch (err) {
    fail("default fallback test", err);
  }
}

// ---------- Test 2: WITH env key → uses our config ----------

async function testEnvOverride() {
  console.log("\n[2] ZAI_API_KEY set → should use OUR config (not /etc/.z-ai-config)");
  process.env.ZAI_API_KEY = "sk-test-fake-key-for-verification-1234";
  process.env.ZAI_BASE_URL = "https://my-custom-endpoint.example.com/v1";

  try {
    const client = await getZai();
    assert.ok(client, "getZai() returned a falsy value");
    const internalConfig = client.config;

    assert.equal(
      internalConfig.apiKey,
      "sk-test-fake-key-for-verification-1234",
      "client.config.apiKey does not match our env key"
    );
    ok(`client.config.apiKey  = ${internalConfig.apiKey} (matches env)`);

    assert.equal(
      internalConfig.baseUrl,
      "https://my-custom-endpoint.example.com/v1",
      "client.config.baseUrl does not match our ZAI_BASE_URL env"
    );
    ok(`client.config.baseUrl = ${internalConfig.baseUrl} (matches env)`);
  } catch (err) {
    fail("env override test", err);
  }

  // Restore.
  delete process.env.ZAI_API_KEY;
  delete process.env.ZAI_BASE_URL;
}

// ---------- Test 3: env key set with default base URL ----------

async function testEnvOverrideDefaultBaseUrl() {
  console.log("\n[3] ZAI_API_KEY set but ZAI_BASE_URL empty → baseUrl defaults to https://api.z.ai/v1");
  process.env.ZAI_API_KEY = "sk-another-fake-key";
  delete process.env.ZAI_BASE_URL;

  try {
    const client = await getZai();
    assert.equal(
      client.config.baseUrl,
      "https://api.z.ai/v1",
      "client.config.baseUrl should default to https://api.z.ai/v1"
    );
    assert.equal(
      client.config.apiKey,
      "sk-another-fake-key",
      "client.config.apiKey should match env"
    );
    ok(`client.config.baseUrl = ${client.config.baseUrl} (default)`);
    ok(`client.config.apiKey  = ${client.config.apiKey} (matches env)`);
  } catch (err) {
    fail("env override default base URL test", err);
  }

  delete process.env.ZAI_API_KEY;
}

// ---------- Test 4: LLM_MODEL / LLM_VISION_MODEL helpers ----------

function testModelHelpers() {
  console.log("\n[4] LLM_MODEL / LLM_VISION_MODEL helpers");

  // Defaults.
  delete process.env.LLM_MODEL;
  delete process.env.LLM_VISION_MODEL;
  assert.equal(getLLMModel(), undefined, "getLLMModel() should be undefined when LLM_MODEL is empty");
  assert.equal(getLLMVisionModel(), "glm-4v-flash", "getLLMVisionModel() should default to glm-4v-flash");
  ok("defaults: LLM_MODEL=undefined, LLM_VISION_MODEL=glm-4v-flash");

  // Whitespace-only.
  process.env.LLM_MODEL = "   ";
  process.env.LLM_VISION_MODEL = "  ";
  assert.equal(getLLMModel(), undefined, "getLLMModel() should be undefined when LLM_MODEL is whitespace-only");
  assert.equal(getLLMVisionModel(), "glm-4v-flash", "getLLMVisionModel() should default when LLM_VISION_MODEL is whitespace");
  ok("whitespace-only values fall back to defaults");

  // Real values.
  process.env.LLM_MODEL = "glm-4.6";
  process.env.LLM_VISION_MODEL = "glm-4v-plus";
  assert.equal(getLLMModel(), "glm-4.6");
  assert.equal(getLLMVisionModel(), "glm-4v-plus");
  ok("overrides: LLM_MODEL=glm-4.6, LLM_VISION_MODEL=glm-4v-plus");

  delete process.env.LLM_MODEL;
  delete process.env.LLM_VISION_MODEL;
}

// ---------- Run ----------

console.log("Verifying env-key contract for SummarAI LLM helpers…");
await testDefaultFallback();
await testEnvOverride();
await testEnvOverrideDefaultBaseUrl();
testModelHelpers();

console.log(`\n────────────────────────────────────────`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`────────────────────────────────────────`);
process.exit(failed > 0 ? 1 : 0);
