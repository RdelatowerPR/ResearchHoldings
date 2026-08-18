// Rebuild the holdings and members tables from data/holdings-snapshot.json.
//
// For when a run wrote something wrong and you'd rather not unpick a binary blob out
// of git history. Check out the snapshot from a good commit, then run this:
//
//   git checkout <good-sha> -- data/holdings-snapshot.json
//   node scripts/restoreFromSnapshot.js
//
// The current database is backed up first. Prices are untouched.

const Database = require("better-sqlite3");

const { createLogger } = require("./lib/logger");
const { backupDatabase, readSnapshot, restoreFromSnapshot } = require("./lib/backup");

const DB_FILE = process.env.HOLDINGS_DB || "data/holdings.db";

const logger = createLogger("restore");

(async () => {
  const db = new Database(DB_FILE);

  try {
    const snapshot = readSnapshot();
    logger.info(`Snapshot generated at ${snapshot.generatedAt}: ${snapshot.holdings.length} holdings`);

    backupDatabase(DB_FILE, { logger });
    const restored = restoreFromSnapshot(db, snapshot, { logger });

    const active = db.prepare("SELECT COUNT(*) as count FROM holdings WHERE status = 'active'").get().count;
    logger.info(`Done. ${restored} holdings restored, ${active} now active.`);
  } catch (error) {
    logger.error(`Restore failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
    await logger.close();
  }
})();
