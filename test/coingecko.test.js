const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CoinGeckoClient,
  authFailureReason,
  PRO_BASE,
  PUBLIC_BASE,
} = require("../scripts/lib/coingecko");

// A logger that records instead of printing, so tests can assert on what was said.
function recordingLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (...a) => lines.info.push(a.join(" ")),
    warn: (...a) => lines.warn.push(a.join(" ")),
    error: (...a) => lines.error.push(a.join(" ")),
  };
}

function httpError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

test("authFailureReason recognises a dead key and ignores everything else", () => {
  assert.match(authFailureReason(httpError(401)), /401/);
  assert.match(authFailureReason(httpError(403)), /403/);
  assert.match(
    authFailureReason(httpError(400, { error_code: 10010, status: { error_message: "pro key" } })),
    /10010/
  );

  // Not key problems: rate limits, server errors, network trouble
  assert.equal(authFailureReason(httpError(429)), null);
  assert.equal(authFailureReason(httpError(500)), null);
  assert.equal(authFailureReason(new Error("ETIMEDOUT")), null);
});

test("with no key the client starts keyless and says so", async () => {
  const logger = recordingLogger();
  const client = new CoinGeckoClient({ logger, request: async () => ({ data: {} }) });

  assert.equal(client.mode, "keyless");
  assert.equal(client.baseUrl, PUBLIC_BASE);
  assert.deepEqual(client.headers, {});

  assert.equal(await client.verify(), false);
  assert.ok(logger.lines.warn.some(l => l.includes("No COINGECKO_API_KEY")));
});

test("a working key verifies and is used on the pro host", async () => {
  const logger = recordingLogger();
  const seen = [];
  const client = new CoinGeckoClient({
    apiKey: "CG-test",
    logger,
    request: async (url, config) => {
      seen.push({ url, headers: config.headers });
      return { data: { gecko_says: "hi" } };
    },
  });

  assert.equal(await client.verify(), true);
  assert.equal(client.mode, "pro");
  assert.equal(seen[0].url, `${PRO_BASE}/ping`);
  assert.equal(seen[0].headers["x-cg-pro-api-key"], "CG-test");
  assert.equal(client.status.verified, true);
});

test("an expired key demotes to the keyless endpoint at verification, loudly", async () => {
  const logger = recordingLogger();
  const client = new CoinGeckoClient({
    apiKey: "CG-expired",
    logger,
    request: async () => { throw httpError(401); },
  });

  assert.equal(await client.verify(), false);
  assert.equal(client.mode, "keyless");
  assert.equal(client.baseUrl, PUBLIC_BASE);
  assert.deepEqual(client.headers, {}, "the dead key must not be sent anymore");

  const warning = logger.lines.warn.join(" ");
  assert.match(warning, /COINGECKO KEY FAILED/);
  assert.match(warning, /401/);
  assert.match(warning, /keyless/);
  assert.match(client.status.demotionReason, /401/);
});

test("a key that dies mid-run demotes and the request still succeeds", async () => {
  const logger = recordingLogger();
  const calls = [];

  const client = new CoinGeckoClient({
    apiKey: "CG-revoked",
    logger,
    request: async (url) => {
      calls.push(url);
      if (url.startsWith(PRO_BASE)) throw httpError(403);
      return { data: { bitcoin: { usd: 64000 } } };
    },
  });

  const response = await client.get("/simple/price", { ids: "bitcoin" });

  assert.deepEqual(response.data, { bitcoin: { usd: 64000 } });
  assert.equal(client.mode, "keyless");
  assert.deepEqual(calls, [`${PRO_BASE}/simple/price`, `${PUBLIC_BASE}/simple/price`]);
  assert.ok(logger.lines.warn.some(l => l.includes("COINGECKO KEY FAILED")));
});

test("demoting drops the rate limits to keyless pacing", async () => {
  const client = new CoinGeckoClient({
    apiKey: "CG-test",
    logger: recordingLogger(),
    request: async () => { throw httpError(401); },
  });

  const proLimits = { ...client.limits };
  await client.verify();

  assert.ok(client.limits.requestDelay > proLimits.requestDelay, "keyless must slow down");
  assert.ok(client.limits.batchSize < proLimits.batchSize, "keyless must use smaller batches");
});

test("a network blip does not throw the key away", async () => {
  const logger = recordingLogger();
  const client = new CoinGeckoClient({
    apiKey: "CG-fine",
    logger,
    request: async () => { throw new Error("ECONNRESET"); },
  });

  assert.equal(await client.verify(), true, "unreachable is not the same as rejected");
  assert.equal(client.mode, "pro");
  assert.equal(client.status.demotionReason, null);
});

test("rate limits back off and then succeed", async () => {
  let attempts = 0;
  const client = new CoinGeckoClient({
    logger: recordingLogger(),
    request: async () => {
      attempts++;
      if (attempts < 2) throw httpError(429);
      return { data: { ok: true } };
    },
  });
  // Keyless delay would make this slow; shorten it for the test
  Object.defineProperty(client, "limits", { get: () => ({ requestDelay: 1, batchSize: 10 }) });

  const response = await client.get("/ping");
  assert.deepEqual(response.data, { ok: true });
  assert.equal(attempts, 2);
});

test("a non-retryable error is raised rather than swallowed", async () => {
  const client = new CoinGeckoClient({
    logger: recordingLogger(),
    request: async () => { throw httpError(404, "not found"); },
  });

  await assert.rejects(() => client.get("/coins/nope"), /404/);
});
