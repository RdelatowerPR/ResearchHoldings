// Point-in-time holdings observations.
//
// `holdings` is a current-state table: one row per member/asset with a status. That
// answers "what is held now" but cannot answer "what was held in November", and it is
// what the dashboard reads - so recovered history goes here instead, additively,
// leaving the live tables untouched.
//
// One row per (observed_date, member, asset). The unique constraint makes re-importing
// the same capture a no-op, so backfills are safe to re-run.

function createHistoryTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS holdings_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_date TEXT NOT NULL,
      name TEXT NOT NULL,
      team TEXT,
      asset TEXT NOT NULL,
      asset_type TEXT,
      source TEXT NOT NULL,
      UNIQUE(observed_date, name, asset)
    );
    CREATE INDEX IF NOT EXISTS idx_history_date ON holdings_history(observed_date);
    CREATE INDEX IF NOT EXISTS idx_history_name ON holdings_history(name);
    CREATE INDEX IF NOT EXISTS idx_history_asset ON holdings_history(asset);
  `);
}

/**
 * Record one capture's worth of holdings. Returns how many rows were new.
 * Refuses an empty list - a date with no holdings is a failed parse, and writing it
 * would assert that nobody held anything that day.
 */
function recordObservations(db, observedDate, holdings, source) {
  if (!Array.isArray(holdings) || holdings.length === 0) {
    throw new Error(`Refusing to record ${observedDate}: no holdings parsed`);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO holdings_history (observed_date, name, team, asset, asset_type, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const before = db.prepare("SELECT COUNT(*) as count FROM holdings_history").get().count;

  db.transaction(rows => {
    for (const h of rows) {
      insert.run(observedDate, h.name, h.team, h.asset, h.assetType, source);
    }
  })(holdings);

  return db.prepare("SELECT COUNT(*) as count FROM holdings_history").get().count - before;
}

function importedDates(db) {
  return new Set(
    db.prepare("SELECT DISTINCT observed_date FROM holdings_history").all().map(r => r.observed_date)
  );
}

module.exports = { createHistoryTable, recordObservations, importedDates };
