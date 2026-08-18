const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const { createHistoryTable, recordObservations, importedDates } = require("../scripts/lib/history");

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "history-test-"));
  const db = new Database(path.join(dir, "h.db"));
  createHistoryTable(db);
  return db;
}

const holding = (name, asset, extra = {}) => ({
  name, asset, team: "Blockworks Research", assetType: "crypto", ...extra,
});

test("observations are recorded per capture date", () => {
  const db = freshDb();
  const written = recordObservations(db, "2025-11-09", [
    holding("Jane Doe", "BTC"),
    holding("Jane Doe", "HYPE"),
    holding("John Roe", "ETH"),
  ], "archive.org/20251109215900");

  assert.equal(written, 3);
  assert.equal(db.prepare("SELECT COUNT(*) as c FROM holdings_history").get().c, 3);

  const row = db.prepare("SELECT * FROM holdings_history WHERE name='Jane Doe' AND asset='BTC'").get();
  assert.equal(row.observed_date, "2025-11-09");
  assert.equal(row.team, "Blockworks Research");
  assert.equal(row.source, "archive.org/20251109215900");
  db.close();
});

test("re-importing the same capture is a no-op", () => {
  const db = freshDb();
  const rows = [holding("Jane Doe", "BTC"), holding("Jane Doe", "HYPE")];

  assert.equal(recordObservations(db, "2025-11-09", rows, "archive.org/x"), 2);
  assert.equal(recordObservations(db, "2025-11-09", rows, "archive.org/x"), 0, "second import adds nothing");
  assert.equal(db.prepare("SELECT COUNT(*) as c FROM holdings_history").get().c, 2);
  db.close();
});

test("the same holding on two dates is two observations", () => {
  const db = freshDb();
  recordObservations(db, "2025-08-24", [holding("Jane Doe", "BTC")], "a");
  recordObservations(db, "2025-11-09", [holding("Jane Doe", "BTC")], "b");

  assert.equal(db.prepare("SELECT COUNT(*) as c FROM holdings_history").get().c, 2);
  assert.deepEqual([...importedDates(db)].sort(), ["2025-08-24", "2025-11-09"]);
  db.close();
});

test("an empty capture is refused, not recorded as 'held nothing'", () => {
  const db = freshDb();
  // A failed parse must never assert that a date had no holdings - that is the same
  // mistake that emptied the live register for fourteen months.
  assert.throws(() => recordObservations(db, "2025-11-09", [], "a"), /Refusing to record/);
  assert.throws(() => recordObservations(db, "2025-11-09", null, "a"), /Refusing to record/);
  assert.equal(db.prepare("SELECT COUNT(*) as c FROM holdings_history").get().c, 0);
  db.close();
});

test("history can answer what was held on a date the collector missed", () => {
  const db = freshDb();
  recordObservations(db, "2025-11-09", [
    holding("Shaunda Devens", "SYRUP"),
    holding("Shaunda Devens", "ETH"),
  ], "a");
  recordObservations(db, "2026-04-19", [holding("Shaunda Devens", "vHYPE")], "b");

  const inNov = db.prepare(
    "SELECT asset FROM holdings_history WHERE name=? AND observed_date=? ORDER BY asset"
  ).all("Shaunda Devens", "2025-11-09").map(r => r.asset);

  assert.deepEqual(inNov, ["ETH", "SYRUP"]);

  // and the position that existed only in the gap
  const everHeld = db.prepare(
    "SELECT DISTINCT asset FROM holdings_history WHERE name=? ORDER BY asset"
  ).all("Shaunda Devens").map(r => r.asset);
  assert.deepEqual(everHeld, ["ETH", "SYRUP", "vHYPE"]);
  db.close();
});
