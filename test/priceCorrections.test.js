const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const {
  readCorrections,
  planCorrections,
  applyCorrections,
  nearestPoint,
  formatCorrectionsFile,
} = require("../scripts/lib/priceCorrections");

const APPLY_SCRIPT = path.join(__dirname, "..", "scripts", "applyPriceCorrections.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "price-corrections-test-"));
}

// Three HYPE rows stored at the wrong token's flat price, then real prices.
function seedPrices(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT NOT NULL, price REAL NOT NULL,
      date TEXT NOT NULL, source TEXT NOT NULL
    );
    INSERT INTO prices (asset, price, date, source) VALUES
      ('HYPE', 0.050472, '2025-03-08T07:11:32.589Z', 'coingecko'),
      ('BTC',  86000,    '2025-03-08T07:11:32.600Z', 'coingecko'),
      ('HYPE', 0.050472, '2025-03-09T04:45:17.643Z', 'coingecko'),
      ('HYPE', 0.050472, '2026-08-17T01:00:45.422Z', 'coingecko'),
      ('HYPE', 58.71,    '2026-08-17T21:19:17.768Z', 'coingecko');
  `);
  return db;
}

const HYPE_ROWS = [
  { id: 1, date: "2025-03-08T07:11:32.589Z", from: 0.050472, to: 15.814339 },
  { id: 3, date: "2025-03-09T04:45:17.643Z", from: 0.050472, to: 15.544339 },
  { id: 4, date: "2026-08-17T01:00:45.422Z", from: 0.050472, to: 57.317849 },
];

function writeCorrections(dir, rows = HYPE_ROWS) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "HYPE-2025-03-08-to-2026-08-17.json"),
    formatCorrectionsFile({ asset: "HYPE", source: "coingecko-backfill" }, rows)
  );
}

function setup() {
  const dir = tempDir();
  const dbFile = path.join(dir, "holdings.db");
  const correctionsDir = path.join(dir, "corrections");
  seedPrices(dbFile).close();
  writeCorrections(correctionsDir);
  return { dir, dbFile, correctionsDir };
}

const prices = db => db.prepare("SELECT id, price, source FROM prices ORDER BY id").all();

test("a correction replaces the bad price, tags the row, and leaves every other row alone", () => {
  const { dbFile, correctionsDir } = setup();
  const db = new Database(dbFile);

  const plan = planCorrections(db, readCorrections({ dir: correctionsDir }));
  assert.equal(plan.toApply.length, 3);
  assert.deepEqual(plan.problems, []);
  assert.equal(applyCorrections(db, plan), 3);

  assert.deepEqual(prices(db), [
    { id: 1, price: 15.814339, source: "coingecko-backfill" },
    { id: 2, price: 86000, source: "coingecko" },
    { id: 3, price: 15.544339, source: "coingecko-backfill" },
    { id: 4, price: 57.317849, source: "coingecko-backfill" },
    { id: 5, price: 58.71, source: "coingecko" },
  ]);
  db.close();
});

test("applying again is a no-op, so the daily run can carry it forever", () => {
  const { dbFile, correctionsDir } = setup();
  const db = new Database(dbFile);
  const corrections = readCorrections({ dir: correctionsDir });

  applyCorrections(db, planCorrections(db, corrections));
  const again = planCorrections(db, corrections);

  assert.equal(again.toApply.length, 0);
  assert.equal(again.alreadyApplied, 3);
  assert.deepEqual(again.problems, []);
  assert.equal(applyCorrections(db, again), 0);
  db.close();
});

test("a row holding anything unexpected stops the whole set, and nothing is written", () => {
  const { dbFile, correctionsDir } = setup();
  const db = new Database(dbFile);
  // Someone or something already changed row 3: the correction no longer describes
  // this database, so even the rows that do match must be left alone.
  db.prepare("UPDATE prices SET price = 1.23 WHERE id = 3").run();
  const before = prices(db);

  const plan = planCorrections(db, readCorrections({ dir: correctionsDir }));
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /row 3 .* holds 1\.23/);
  assert.throws(() => applyCorrections(db, plan), /Refusing to apply/);
  assert.deepEqual(prices(db), before);
  db.close();
});

test("a row id that now points at another asset or time is refused", () => {
  const { dbFile, correctionsDir } = setup();
  writeCorrections(correctionsDir, [{ id: 2, date: "2025-03-08T07:11:32.600Z", from: 0.050472, to: 15.8 }]);
  const db = new Database(dbFile);

  const plan = planCorrections(db, readCorrections({ dir: correctionsDir }));
  assert.equal(plan.toApply.length, 0);
  assert.match(plan.problems[0], /is BTC 2025-03-08T07:11:32.600Z in the database/);
  db.close();
});

test("a guarded update that loses a race rolls back every row", () => {
  const { dbFile, correctionsDir } = setup();
  const db = new Database(dbFile);
  const plan = planCorrections(db, readCorrections({ dir: correctionsDir }));

  // Changed after planning, before writing
  db.prepare("UPDATE prices SET price = 2 WHERE id = 4").run();
  const before = prices(db);
  assert.throws(() => applyCorrections(db, plan), /row 4 changed while being corrected/);
  assert.deepEqual(prices(db), before);
  db.close();
});

test("a malformed corrections file is refused before anything is planned", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({
    asset: "HYPE", source: "coingecko-backfill", rows: [{ id: 1, date: "2025-03-08", from: 0.050472, to: 0 }],
  }));
  assert.throws(() => readCorrections({ dir }), /positive "from" and "to"/);

  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ asset: "HYPE", source: "x", rows: [] }));
  assert.throws(() => readCorrections({ dir }), /no rows/);
});

test("no corrections directory means nothing to do", () => {
  assert.deepEqual(readCorrections({ dir: path.join(tempDir(), "absent") }), []);
});

test("the formatted file reads back to the same rows, one row per line", () => {
  const dir = tempDir();
  writeCorrections(dir);
  const text = fs.readFileSync(path.join(dir, "HYPE-2025-03-08-to-2026-08-17.json"), "utf8");

  assert.deepEqual(readCorrections({ dir })[0].rows, HYPE_ROWS);
  assert.equal(text.split("\n").filter(line => line.includes('"id":')).length, HYPE_ROWS.length);
});

test("nearestPoint takes the closest point and refuses one too far away", () => {
  const hour = 3600 * 1000;
  const series = [[0, 10], [hour, 11], [2 * hour, 12], [10 * hour, 20]];

  assert.deepEqual(nearestPoint(series, 0.4 * hour, hour), [0, 10]);
  assert.deepEqual(nearestPoint(series, 0.6 * hour, hour), [hour, 11]);
  assert.deepEqual(nearestPoint(series, 2.2 * hour, hour), [2 * hour, 12]);
  assert.deepEqual(nearestPoint(series, -0.5 * hour, hour), [0, 10]);
  assert.equal(nearestPoint(series, 6 * hour, hour), null, "4 hours from the nearest point");
  assert.equal(nearestPoint([], 0, hour), null);
});

// The workflow runs the script, not the library, so check the script's own behaviour:
// exit codes, the run record, and that a dry run writes nothing.
function runScript(env, args = []) {
  return spawnSync(process.execPath, [APPLY_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function scriptEnv({ dir, dbFile, correctionsDir }) {
  return {
    HOLDINGS_DB: dbFile,
    PRICE_CORRECTIONS_DIR: correctionsDir,
    LOG_DIR: path.join(dir, "logs"),
    RUN_HISTORY: path.join(dir, "run-history.jsonl"),
    BACKUP_DIR: path.join(dir, "backups"),
  };
}

test("the script applies, backs up first, records the run, and is quiet the second time", () => {
  const ctx = setup();
  const env = scriptEnv(ctx);

  const first = runScript(env);
  assert.equal(first.status, 0, first.stderr);
  const second = runScript(env);
  assert.equal(second.status, 0, second.stderr);

  const runs = fs.readFileSync(env.RUN_HISTORY, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(runs.map(r => [r.job, r.ok, r.applied, r.alreadyApplied]), [
    ["price-corrections", true, 3, 0],
    ["price-corrections", true, 0, 3],
  ]);
  assert.equal(fs.readdirSync(env.BACKUP_DIR).length, 1, "a backup only when something is written");

  const db = new Database(ctx.dbFile, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM prices WHERE source = 'coingecko-backfill'").get().c, 3);
  db.close();
});

test("the script's dry run writes nothing and records nothing", () => {
  const ctx = setup();
  const env = scriptEnv(ctx);

  const run = runScript(env, ["--dry-run"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /3 to correct, 0 already corrected/);
  assert.equal(fs.existsSync(env.RUN_HISTORY), false);

  const db = new Database(ctx.dbFile, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM prices WHERE price = 0.050472").get().c, 3);
  db.close();
});

test("the script fails the run, and writes nothing, when a row doesn't match", () => {
  const ctx = setup();
  const env = scriptEnv(ctx);
  const db = new Database(ctx.dbFile);
  db.prepare("UPDATE prices SET price = 1.23 WHERE id = 3").run();
  db.close();

  const run = runScript(env);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /nothing was written/);

  const record = JSON.parse(fs.readFileSync(env.RUN_HISTORY, "utf8").trim());
  assert.equal(record.ok, false);

  const after = new Database(ctx.dbFile, { readonly: true });
  assert.equal(after.prepare("SELECT COUNT(*) AS c FROM prices WHERE source = 'coingecko-backfill'").get().c, 0);
  after.close();
});
