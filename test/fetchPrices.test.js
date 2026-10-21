const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const { readRunHistory } = require("../scripts/lib/logger");

// Runs the real collector script start to finish, as the workflow does, but in a temp
// directory, against a scratch database, with every API call answered from canned
// replies. What it checks is what the workflow acts on: the exit code, which decides
// whether the collector-failure issue opens, and the run record that gets committed.

const SCRIPT = path.resolve(__dirname, "../scripts/fetchPrices.js");

// Alpha Vantage's rate-limit reply: HTTP 200, no quote, the reason in "Information".
const DAILY_LIMIT =
  "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily rate limits.";

const quote = price => ({ "Global Quote": { "01. symbol": "X", "05. price": price } });

// Loaded into the collector's process with --require. It is written out to a file, so
// it must not close over anything: all it needs arrives as arguments.
function installFakeApis(axiosPath, replies) {
  const axios = require(axiosPath);

  // Anything not answered below fails fast instead of reaching the network
  axios.defaults.adapter = async config => {
    throw new Error(`unexpected request in test: ${config.url}`);
  };

  axios.get = async (url, config = {}) => {
    const params = config.params || {};
    if (url.endsWith("/ping")) return { data: { gecko_says: "(V3) To the Moon!" } };

    if (url.endsWith("/simple/price")) {
      const data = {};
      for (const id of String(params.ids).split(",")) {
        if (id in replies.coingecko) data[id] = { usd: replies.coingecko[id] };
      }
      return { data };
    }

    if (url.startsWith("https://www.alphavantage.co/") && params.symbol in replies.alphaVantage) {
      return { data: replies.alphaVantage[params.symbol] };
    }
    throw new Error(`unexpected request in test: ${url}`);
  };

  // The collector waits 15 s per equity for Alpha Vantage's rate limit. Nothing here
  // is rate limited, so every timer fires at once.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, 0, ...args);
}

// Two crypto and two equity holdings, plus an equity nobody holds anymore. The prices
// table is there already, as in the real database: main() counts it before anything.
function seedDatabase(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, team TEXT);
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, asset TEXT, asset_type TEXT,
      first_added TEXT, status TEXT DEFAULT 'active', last_seen TEXT, UNIQUE(member_id, asset)
    );
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT NOT NULL, price REAL NOT NULL,
      date TEXT NOT NULL, source TEXT NOT NULL
    );
    INSERT INTO members (name, team) VALUES ('Jane Doe', 'Blockworks Research'), ('John Roe', 'Blockworks Media');
    INSERT INTO holdings (member_id, asset, asset_type, first_added, status, last_seen) VALUES
      (1, 'BTC', 'crypto', '2025-03-07', 'active', '2026-09-21'),
      (2, 'ETH', 'crypto', '2025-03-07', 'active', '2026-09-21'),
      (1, 'COIN', 'equity', '2025-03-07', 'active', '2026-09-21'),
      (2, 'HOOD', 'equity', '2026-01-01', 'active', '2026-09-21'),
      (2, 'TSLA', 'equity', '2025-03-07', 'inactive', '2026-06-01');
  `);
  db.close();
}

function runCollector(equityReplies) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-holdings-prices-"));
  const dbFile = path.join(dir, "holdings.db");
  const historyFile = path.join(dir, "run-history.jsonl");
  seedDatabase(dbFile);

  const replies = { coingecko: { bitcoin: 64000, ethereum: 3100 }, alphaVantage: equityReplies };
  const preload = path.join(dir, "fake-apis.js");
  fs.writeFileSync(
    preload,
    `(${installFakeApis})(${JSON.stringify(require.resolve("axios"))}, ${JSON.stringify(replies)});\n`
  );

  const env = {
    ...process.env,
    HOLDINGS_DB: dbFile,
    LOG_DIR: path.join(dir, "logs"),
    RUN_HISTORY: historyFile,
    COINGECKO_API_KEY: "CG-test",
    ALPHA_VANTAGE_API_KEY: "test-key",
  };

  // The temp directory is the working directory too, so even a default relative path
  // (data/holdings.db, logs/, .env) resolves there and never into the repository.
  const run = spawnSync(process.execPath, ["--require", preload, SCRIPT], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 60000,
  });

  const history = readRunHistory({ file: historyFile });
  const db = new Database(dbFile, { readonly: true });
  const prices = db.prepare("SELECT source, COUNT(*) AS n FROM prices GROUP BY source ORDER BY source").all();
  db.close();
  const logFile = path.join(dir, "logs", "prices.log");
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  fs.rmSync(dir, { recursive: true, force: true });

  return { run, record: history[history.length - 1], prices, log, output: `${run.stdout}${run.stderr}` };
}

test("a run where Alpha Vantage answers every equity with Information fails, and keeps the crypto prices", () => {
  const { run, record, prices, log, output } = runCollector({
    COIN: { Information: DAILY_LIMIT },
    HOOD: { Information: DAILY_LIMIT },
  });
  assert.ok(record, `the collector wrote no run record:\n${output}`);

  // The 2026-09-21 run stored no equity price and recorded ok:true with 0 warnings
  assert.deepEqual(
    { exitCode: run.status, ok: record.ok, warningCount: record.warningCount },
    { exitCode: 1, ok: false, warningCount: 2 }
  );

  assert.match(record.error, /No equity prices stored: 0 of 2 active equities priced/);
  assert.deepEqual([...record.equitiesMissing].sort(), ["COIN", "HOOD"]);
  assert.deepEqual(prices, [{ source: "coingecko", n: 2 }], "the crypto prices from the same run are kept");
  assert.match(log, /No price for COIN: Information: Thank you for using Alpha Vantage/);
  assert.match(log, /No price for HOOD: Information: Thank you for using Alpha Vantage/);
});

test("a run that loses some equities passes, with a warning for each one", () => {
  const { run, record, prices, log, output } = runCollector({
    COIN: quote("312.4500"),
    HOOD: { Information: DAILY_LIMIT },
  });
  assert.ok(record, `the collector wrote no run record:\n${output}`);

  // The 2026-09-11 run stored 2 of 9 equities and also recorded 0 warnings
  assert.deepEqual(
    { exitCode: run.status, ok: record.ok, warningCount: record.warningCount },
    { exitCode: 0, ok: true, warningCount: 1 }
  );

  assert.deepEqual(record.equitiesMissing, ["HOOD"]);
  assert.equal(record.equitiesStored, 1);
  assert.deepEqual(prices, [{ source: "alphavantage", n: 1 }, { source: "coingecko", n: 2 }]);
  assert.match(log, /No price for HOOD: Information: Thank you for using Alpha Vantage/);
});

test("a run that prices every equity passes with no warnings", () => {
  const { run, record, prices, output } = runCollector({
    COIN: quote("312.4500"),
    HOOD: quote("24.1000"),
  });
  assert.ok(record, `the collector wrote no run record:\n${output}`);

  assert.deepEqual(
    { exitCode: run.status, ok: record.ok, warningCount: record.warningCount },
    { exitCode: 0, ok: true, warningCount: 0 }
  );
  assert.deepEqual(prices, [{ source: "alphavantage", n: 2 }, { source: "coingecko", n: 2 }]);
});
