const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  fetchEquityPrices,
  equityOutage,
  describeMissingQuote,
  ALPHA_VANTAGE_URL,
} = require("../scripts/lib/alphaVantage");

// Alpha Vantage's rate-limit reply: HTTP 200, no quote, the reason in "Information".
const DAILY_LIMIT =
  "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.";

const quote = price => ({ "Global Quote": { "01. symbol": "X", "05. price": price } });
const noWait = async () => {};

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

// An in-memory database holding the given equities, plus what the query must skip:
// a crypto holding and an equity nobody holds anymore. Never the real data/.
function heldDb(equities) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, asset TEXT, asset_type TEXT,
      first_added TEXT, status TEXT DEFAULT 'active', last_seen TEXT
    );
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT NOT NULL, price REAL NOT NULL,
      date TEXT NOT NULL, source TEXT NOT NULL
    );
  `);
  const hold = db.prepare("INSERT INTO holdings (member_id, asset, asset_type, status) VALUES (?, ?, ?, ?)");
  equities.forEach((asset, i) => hold.run(i + 1, asset, "equity", "active"));
  hold.run(1, "BTC", "crypto", "active");
  hold.run(2, "TSLA", "equity", "inactive");
  return db;
}

// Answers each symbol from canned replies (an Error is thrown) and records each call
function fakeAlphaVantage(replies) {
  const calls = [];
  const request = async (url, config) => {
    calls.push({ url, ...config.params });
    const reply = replies[config.params.symbol];
    if (reply instanceof Error) throw reply;
    return { data: reply };
  };
  return { calls, request };
}

function storedPrices(db) {
  return db.prepare("SELECT asset, price, source FROM prices ORDER BY asset").all();
}

test("Information for every equity stores nothing, warns once per equity in the API's words, and is an outage", async () => {
  const db = heldDb(["COIN", "HOOD", "IBIT"]);
  const logger = recordingLogger();
  const api = fakeAlphaVantage({
    COIN: { Information: DAILY_LIMIT },
    HOOD: { Information: DAILY_LIMIT },
    IBIT: { Information: DAILY_LIMIT },
  });

  const result = await fetchEquityPrices({ db, logger, apiKey: "test-key", request: api.request, wait: noWait });

  assert.equal(result.active, 3);
  assert.equal(result.stored, 0);
  assert.deepEqual(result.missing.map(m => m.asset).sort(), ["COIN", "HOOD", "IBIT"]);
  assert.deepEqual(storedPrices(db), []);

  assert.equal(logger.lines.warn.length, 3, "each unpriced equity is one warning");
  for (const asset of ["COIN", "HOOD", "IBIT"]) {
    assert.ok(
      logger.lines.warn.includes(`No price for ${asset}: Information: ${DAILY_LIMIT}`),
      `${asset}'s warning quotes the reply`
    );
  }

  assert.match(equityOutage(result), /^No equity prices stored: 0 of 3 active equities priced/);
  db.close();
});

test("Note, Error Message and an empty quote are each reported, and the good quote is still stored", async () => {
  const db = heldDb(["COIN", "HOOD", "NOPE", "GONE"]);
  const logger = recordingLogger();
  const api = fakeAlphaVantage({
    COIN: quote("312.4500"),
    HOOD: { Note: "Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute." },
    NOPE: { "Error Message": "Invalid API call. Please retry or visit the documentation." },
    GONE: { "Global Quote": {} },
  });

  const result = await fetchEquityPrices({ db, logger, apiKey: "test-key", request: api.request, wait: noWait });

  assert.equal(result.stored, 1);
  assert.deepEqual(storedPrices(db), [{ asset: "COIN", price: 312.45, source: "alphavantage" }]);

  assert.equal(logger.lines.warn.length, 3);
  const warnings = logger.lines.warn.join("\n");
  assert.match(warnings, /No price for HOOD: Note: Thank you for using Alpha Vantage/);
  assert.match(warnings, /No price for NOPE: Error Message: Invalid API call/);
  assert.match(warnings, /No price for GONE: empty "Global Quote"/);

  assert.equal(equityOutage(result), null, "losing some equities is warnings, not a failed run");
  db.close();
});

test("a request that throws costs that equity only", async () => {
  const db = heldDb(["COIN", "HOOD"]);
  const logger = recordingLogger();
  const unavailable = new Error("Request failed with status code 503");
  unavailable.response = { status: 503, data: "Service Unavailable" };
  const api = fakeAlphaVantage({ COIN: unavailable, HOOD: quote("24.1000") });

  const result = await fetchEquityPrices({ db, logger, apiKey: "test-key", request: api.request, wait: noWait });

  assert.equal(result.stored, 1);
  assert.deepEqual(result.missing.map(m => m.asset), ["COIN"]);
  assert.deepEqual(logger.lines.warn, ["No price for COIN: HTTP 503 Service Unavailable"]);
  db.close();
});

test("a quote without a usable price is not stored", async () => {
  const db = heldDb(["COIN", "HOOD"]);
  const logger = recordingLogger();
  const api = fakeAlphaVantage({ COIN: quote("0.0000"), HOOD: quote("") });

  const result = await fetchEquityPrices({ db, logger, apiKey: "test-key", request: api.request, wait: noWait });

  assert.equal(result.stored, 0);
  assert.deepEqual(storedPrices(db), []);
  assert.equal(logger.lines.warn.length, 2);
  assert.ok(logger.lines.warn.every(l => l.includes('"Global Quote" without a usable price')));
  db.close();
});

test("without a key every active equity is a warning, nothing is requested, and it is an outage", async () => {
  const db = heldDb(["COIN", "HOOD"]);
  const logger = recordingLogger();
  const api = fakeAlphaVantage({});

  const result = await fetchEquityPrices({ db, logger, apiKey: undefined, request: api.request, wait: noWait });

  assert.equal(api.calls.length, 0);
  assert.equal(result.stored, 0);
  assert.equal(logger.lines.warn.length, 2);
  assert.ok(logger.lines.warn.every(l => l.endsWith("ALPHA_VANTAGE_API_KEY is not set")));
  assert.match(equityOutage(result), /0 of 2 active equities priced/);
  db.close();
});

test("only active equities are requested, each once, at the rate limit's pace", async () => {
  const db = heldDb(["COIN", "HOOD", "COIN"]); // COIN is held by two members
  const logger = recordingLogger();
  const api = fakeAlphaVantage({ COIN: quote("312.45"), HOOD: quote("24.10") });
  const waits = [];

  const result = await fetchEquityPrices({
    db,
    logger,
    apiKey: "test-key",
    request: api.request,
    wait: async ms => { waits.push(ms); },
  });

  // Not BTC, not the inactive TSLA, and COIN once
  assert.deepEqual(api.calls.map(c => c.symbol).sort(), ["COIN", "HOOD"]);
  for (const call of api.calls) {
    assert.equal(call.url, ALPHA_VANTAGE_URL);
    assert.equal(call.function, "GLOBAL_QUOTE");
    assert.equal(call.apikey, "test-key");
  }
  assert.equal(waits.length, 2);
  assert.ok(waits.every(ms => ms >= 12000), "at most 5 requests a minute");

  assert.deepEqual(result, { active: 2, stored: 2, missing: [] });
  assert.deepEqual(logger.lines.warn, []);
  assert.equal(equityOutage(result), null);
  db.close();
});

test("holding no equities needs no key, warns nothing and is not an outage", async () => {
  const db = heldDb([]);
  const logger = recordingLogger();
  const api = fakeAlphaVantage({});

  const result = await fetchEquityPrices({ db, logger, apiKey: undefined, request: api.request, wait: noWait });

  assert.equal(api.calls.length, 0);
  assert.deepEqual(result, { active: 0, stored: 0, missing: [] });
  assert.deepEqual(logger.lines.warn, []);
  assert.equal(equityOutage(result), null);
  db.close();
});

test("the outage message is short enough for the committed run record", () => {
  const missing = [{ asset: "TSLA", reason: `Information: ${DAILY_LIMIT}` }];
  const message = equityOutage({ active: 9, stored: 0, missing });

  assert.match(message, /^No equity prices stored: 0 of 9 active equities priced \(TSLA: Information: Thank you/);
  assert.match(message, /\.\.\.\)$/, "a cut reason says so");
  assert.ok(message.length < 250, `${message.length} characters`);
  assert.equal(equityOutage({ active: 9, stored: 1, missing }), null);
});

test("describeMissingQuote says what came back instead of a quote", () => {
  assert.equal(describeMissingQuote({ Information: "rate limited" }), "Information: rate limited");
  assert.equal(describeMissingQuote({ Note: "slow down" }), "Note: slow down");
  assert.equal(describeMissingQuote({ "Error Message": "bad symbol" }), "Error Message: bad symbol");
  assert.match(describeMissingQuote({ "Global Quote": {} }), /empty "Global Quote"/);
  assert.match(describeMissingQuote({ something: "else" }), /no "Global Quote" in the reply: \{"something":"else"\}/);
  assert.match(describeMissingQuote("<html>Bad Gateway</html>"), /unexpected reply: <html>Bad Gateway/);
  assert.match(describeMissingQuote(undefined), /unexpected reply/);
});
