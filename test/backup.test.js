const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const { backupDatabase, writeSnapshot, readSnapshot, restoreFromSnapshot } = require("../scripts/lib/backup");
const { appendRunRecord, readRunHistory } = require("../scripts/lib/logger");

const quiet = { info() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "research-holdings-test-"));
}

// A database with the same shape as the real one, seeded with a few holdings.
function seedDatabase(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, team TEXT);
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, asset TEXT, asset_type TEXT,
      first_added TEXT, status TEXT DEFAULT 'active', last_seen TEXT, UNIQUE(member_id, asset)
    );
    INSERT INTO members (name, team) VALUES ('Jane Doe', 'Blockworks Research'), ('John Roe', 'Blockworks Media');
    INSERT INTO holdings (member_id, asset, asset_type, first_added, status, last_seen) VALUES
      (1, 'BTC', 'crypto', '2025-03-07', 'active', '2026-08-17'),
      (1, 'HYPE', 'crypto', '2025-03-07', 'active', '2026-08-17'),
      (2, 'ETH', 'crypto', '2026-01-01', 'inactive', '2026-06-01');
  `);
  return db;
}

test("the database is copied aside before a write, oldest copies rotated out", () => {
  const dir = tempDir();
  const dbFile = path.join(dir, "holdings.db");
  seedDatabase(dbFile).close();

  const backupDir = path.join(dir, "backups");
  const made = [];
  for (let i = 0; i < 5; i++) {
    made.push(backupDatabase(dbFile, { dir: backupDir, keep: 3, logger: quiet }));
  }

  assert.ok(made.every(Boolean));
  const kept = fs.readdirSync(backupDir).filter(f => f.endsWith(".db"));
  assert.equal(kept.length, 3, "rotation should keep exactly the newest 3");

  // The copy has to actually be a usable database, not a truncated file
  const restored = new Database(path.join(backupDir, kept[0]), { readonly: true });
  assert.equal(restored.prepare("SELECT COUNT(*) as c FROM holdings").get().c, 3);
  restored.close();
});

test("backing up a database that isn't there yet is a no-op, not a crash", () => {
  const dir = tempDir();
  assert.equal(backupDatabase(path.join(dir, "missing.db"), { dir: path.join(dir, "b"), logger: quiet }), null);
});

test("the snapshot is text, sorted, and carries the counts", () => {
  const dir = tempDir();
  const db = seedDatabase(path.join(dir, "holdings.db"));
  const file = path.join(dir, "snapshot.json");

  const snapshot = writeSnapshot(db, { file, meta: { strategy: "dom" }, logger: quiet });
  db.close();

  assert.equal(snapshot.counts.total, 3);
  assert.equal(snapshot.counts.active, 2);
  assert.equal(snapshot.counts.members, 2);
  assert.equal(snapshot.strategy, "dom");

  // Sorted by name then asset, so the daily diff shows changes not reordering
  assert.deepEqual(
    snapshot.holdings.map(h => `${h.name}/${h.asset}`),
    ["Jane Doe/BTC", "Jane Doe/HYPE", "John Roe/ETH"]
  );

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(onDisk.holdings, snapshot.holdings);
});

test("a snapshot restores a gutted database back to itself", () => {
  const dir = tempDir();
  const dbFile = path.join(dir, "holdings.db");
  const file = path.join(dir, "snapshot.json");

  const db = seedDatabase(dbFile);
  const before = writeSnapshot(db, { file, logger: quiet });

  // Simulate the failure this whole mechanism exists for: everything marked inactive
  db.exec("UPDATE holdings SET status = 'inactive'");
  assert.equal(db.prepare("SELECT COUNT(*) as c FROM holdings WHERE status='active'").get().c, 0);

  const restored = restoreFromSnapshot(db, readSnapshot({ file }), { logger: quiet });
  assert.equal(restored, 3);
  assert.equal(db.prepare("SELECT COUNT(*) as c FROM holdings WHERE status='active'").get().c, 2);

  const after = writeSnapshot(db, { file: path.join(dir, "after.json"), logger: quiet });
  assert.deepEqual(after.holdings, before.holdings, "restore should round-trip exactly");
  db.close();
});

test("restoring into an empty database rebuilds members too", () => {
  const dir = tempDir();
  const source = seedDatabase(path.join(dir, "source.db"));
  const file = path.join(dir, "snapshot.json");
  writeSnapshot(source, { file, logger: quiet });
  source.close();

  const target = new Database(path.join(dir, "empty.db"));
  target.exec(`
    CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, team TEXT);
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER, asset TEXT, asset_type TEXT,
      first_added TEXT, status TEXT DEFAULT 'active', last_seen TEXT, UNIQUE(member_id, asset)
    );
  `);

  restoreFromSnapshot(target, readSnapshot({ file }), { logger: quiet });

  assert.equal(target.prepare("SELECT COUNT(*) as c FROM members").get().c, 2);
  assert.equal(target.prepare("SELECT team FROM members WHERE name='Jane Doe'").get().team, "Blockworks Research");
  assert.equal(target.prepare("SELECT first_added FROM holdings WHERE asset='BTC'").get().first_added, "2025-03-07");
  target.close();
});

test("a missing or malformed snapshot is refused rather than half-applied", () => {
  const dir = tempDir();
  assert.throws(() => readSnapshot({ file: path.join(dir, "nope.json") }), /No snapshot/);

  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ generatedAt: "now" }));
  assert.throws(() => readSnapshot({ file: bad }), /no holdings array/);
});

test("run records append and stay capped", () => {
  const dir = tempDir();
  const file = path.join(dir, "run-history.jsonl");

  appendRunRecord({ job: "scrape", ok: true, scraped: 182 }, { file });
  appendRunRecord({ job: "prices", ok: false, error: "key rejected" }, { file });

  const history = readRunHistory({ file });
  assert.equal(history.length, 2);
  assert.equal(history[0].scraped, 182);
  assert.equal(history[1].error, "key rejected");
  assert.ok(history[0].at, "every record is timestamped");
});
