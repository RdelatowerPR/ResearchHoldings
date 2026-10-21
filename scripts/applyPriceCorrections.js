// Apply the committed price corrections in data/price-corrections/ to the database.
//
// Runs in the daily workflow after fetchPrices.js, so a corrected database goes out in
// the normal data commit. Safe to run every day: rows already corrected are skipped.
// If any listed row holds something other than the bad price it was built against,
// nothing is written and the run fails - see lib/priceCorrections.js and
// docs/RUNBOOK.md#correcting-stored-prices.
//
// Run: node scripts/applyPriceCorrections.js [--dry-run]
// Env: HOLDINGS_DB             override the database path
//      PRICE_CORRECTIONS_DIR   override where the correction files are read from

const Database = require("better-sqlite3");

const { createLogger, appendRunRecord } = require("./lib/logger");
const { backupDatabase } = require("./lib/backup");
const { readCorrections, planCorrections, applyCorrections } = require("./lib/priceCorrections");

const DB_FILE = process.env.HOLDINGS_DB || "data/holdings.db";
const DRY_RUN = process.argv.includes("--dry-run");

const logger = createLogger("corrections");

(async () => {
  const record = { job: "price-corrections", ok: false };
  let db = null;

  try {
    const corrections = readCorrections();
    const listed = corrections.reduce((sum, c) => sum + c.rows.length, 0);
    record.files = corrections.length;

    db = new Database(DB_FILE, { fileMustExist: true });
    const plan = planCorrections(db, corrections);

    if (plan.problems.length > 0) {
      plan.problems.slice(0, 20).forEach(problem => logger.error(problem));
      if (plan.problems.length > 20) logger.error(`...and ${plan.problems.length - 20} more`);
      throw new Error(`${plan.problems.length} of ${listed} listed rows don't hold the price they were corrected from; nothing was written`);
    }

    logger.info(`${corrections.length} correction files, ${listed} rows: ${plan.toApply.length} to correct, ${plan.alreadyApplied} already corrected.`);

    let applied = 0;
    if (plan.toApply.length > 0 && !DRY_RUN) {
      backupDatabase(DB_FILE, { logger });
      applied = applyCorrections(db, plan);

      // Read it back rather than trusting the transaction's count
      const after = planCorrections(db, corrections);
      if (after.toApply.length > 0 || after.problems.length > 0 || after.alreadyApplied !== listed) {
        throw new Error(`After applying, ${after.alreadyApplied} of ${listed} rows read back as corrected`);
      }
      logger.info(`Corrected ${applied} prices.`);
    } else if (DRY_RUN) {
      logger.info("Dry run: nothing written.");
    }

    Object.assign(record, { ok: true, applied, alreadyApplied: plan.alreadyApplied });
  } catch (error) {
    logger.error(`Price corrections failed: ${error.message}`);
    record.error = error.message;
    process.exitCode = 1;
  } finally {
    if (db) db.close();
    if (!DRY_RUN) appendRunRecord(record);
    await logger.close();
  }
})();
