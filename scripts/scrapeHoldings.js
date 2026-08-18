// Collect the Blockworks financial disclosures into data/holdings.db.
//
// Run: node scripts/scrapeHoldings.js
// Env: BLOCKWORKS_URL  override the page to fetch (default: both known hosts)
//      HOLDINGS_DB     override the database path (default: data/holdings.db)
//      ALLOW_SHRINK=1  permit a scrape that is much smaller than what's stored
//
// Exits non-zero if the page can't be fetched or parsed. See docs/RUNBOOK.md.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const { fetchDisclosuresPage, DEFAULT_URLS } = require("./lib/fetchPage");
const { parseDisclosures } = require("./lib/parseDisclosures");
const { createLogger, appendRunRecord } = require("./lib/logger");
const { backupDatabase, writeSnapshot } = require("./lib/backup");

// Candidate URLs, overridable for a one-off run against a mirror or a saved copy.
const BLOCKWORKS_URLS = process.env.BLOCKWORKS_URL
  ? [process.env.BLOCKWORKS_URL]
  : DEFAULT_URLS;

// Overridable so a test run can point at a scratch copy of the database.
const DB_FILE = process.env.HOLDINGS_DB || "data/holdings.db";

// If a scrape returns far fewer holdings than the database already has active,
// that is a broken parse, not a mass sell-off. Refuse to write below this share.
const MIN_SHRINK_RATIO = 0.5;

// Where the page gets dumped when it can't be parsed, for the workflow to upload
const DEBUG_DIR = "debug";

const logger = createLogger("scrape");
const db = new Database(DB_FILE);

// Function to create or update tables
function initializeDatabase() {
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Check if we need to migrate the holdings table
  const tableInfo = db.prepare("PRAGMA table_info(holdings)").all();
  const hasMemberIdAssetUnique = db.prepare(
    "SELECT COUNT(*) as count FROM sqlite_master WHERE type='index' AND name='idx_holdings_member_asset'"
  ).get().count > 0;

  // Check if we have the status column
  const hasStatusColumn = tableInfo.some(col => col.name === 'status');
  const hasLastSeenColumn = tableInfo.some(col => col.name === 'last_seen');

  // If we need to migrate (add the unique constraint)
  if (tableInfo.length > 0 && (!hasMemberIdAssetUnique || !hasStatusColumn || !hasLastSeenColumn)) {
    logger.info("Migrating database to add new schema...");

    // Create temporary table with the new schema
    db.exec(`
      CREATE TABLE holdings_temp (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER,
        asset TEXT,
        asset_type TEXT,
        first_added TEXT,
        status TEXT DEFAULT 'active',
        last_seen TEXT,
        UNIQUE(member_id, asset)
      );
    `);

    // Copy data to temp table, ensuring no duplicates
    if (hasStatusColumn && hasLastSeenColumn) {
      db.exec(`
        INSERT OR IGNORE INTO holdings_temp (id, member_id, asset, asset_type, first_added, status, last_seen)
        SELECT id, member_id, asset, asset_type, first_added, status, last_seen FROM holdings;
      `);
    } else {
      // If we're adding new columns, set all existing records to active
      const today = new Date().toISOString().split('T')[0];
      db.exec(`
        INSERT OR IGNORE INTO holdings_temp (id, member_id, asset, asset_type, first_added, status, last_seen)
        SELECT id, member_id, asset, asset_type, first_added, 'active', '${today}' FROM holdings;
      `);
    }

    // Drop old table and rename new one
    db.exec(`
      DROP TABLE holdings;
      ALTER TABLE holdings_temp RENAME TO holdings;
    `);

    // Create index
    db.exec(`
      CREATE UNIQUE INDEX idx_holdings_member_asset ON holdings(member_id, asset);
    `);

    logger.info("Migration completed successfully.");
  } else if (tableInfo.length === 0) {
    // Create tables if they don't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        team TEXT
      );

      CREATE TABLE IF NOT EXISTS holdings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER,
        asset TEXT,
        asset_type TEXT,
        first_added TEXT,
        status TEXT DEFAULT 'active',
        last_seen TEXT,
        UNIQUE(member_id, asset)
      );
    `);

    // Create index
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_holdings_member_asset ON holdings(member_id, asset);
    `);
  }
}

// Keep the page that beat us, so the next person can see what changed
function saveFailedPage(html) {
  if (typeof html !== "string") return null;
  try {
    fs.mkdirSync(path.resolve(process.cwd(), DEBUG_DIR), { recursive: true });
    const target = path.resolve(process.cwd(), DEBUG_DIR, "last-failed-page.html");
    fs.writeFileSync(target, html);
    logger.error(`Wrote the unparsed page to ${DEBUG_DIR}/last-failed-page.html`);
    return target;
  } catch (error) {
    logger.error(`Could not save the failed page: ${error.message}`);
    return null;
  }
}

// Refuse to write a scrape that collapsed. An empty or gutted parse used to be
// written straight through, which marked every holding inactive and left the job
// green - the dashboard went blank while CI reported success for fourteen months.
function assertScrapeIsSane(holdings) {
  if (holdings.length === 0) {
    throw new Error(
      "Every parsing strategy came back empty - refusing to write. The disclosures page has changed shape beyond what any reader recognises."
    );
  }

  if (process.env.ALLOW_SHRINK === "1") {
    logger.warn("ALLOW_SHRINK=1 - the shrink guard is disabled for this run.");
    return;
  }

  const activeNow = db.prepare("SELECT COUNT(*) as count FROM holdings WHERE status = 'active'").get().count;
  const floor = Math.floor(activeNow * MIN_SHRINK_RATIO);

  if (activeNow > 0 && holdings.length < floor) {
    throw new Error(
      `Scraped only ${holdings.length} holdings against ${activeNow} currently active (floor ${floor}) - refusing to write. Re-run with ALLOW_SHRINK=1 if the drop is real.`
    );
  }
}

// Function to save scraped data into SQLite without duplicates
function saveToDatabase(holdings) {
  // Get today's date for tracking
  const today = new Date().toISOString().split('T')[0];

  // Begin transaction for better performance
  db.exec('BEGIN TRANSACTION');

  try {
    // Create a temporary table to store current holdings for comparison
    db.exec(`
      DROP TABLE IF EXISTS current_holdings;
      CREATE TEMPORARY TABLE current_holdings (
        member_id INTEGER,
        asset TEXT,
        PRIMARY KEY (member_id, asset)
      );
    `);

    // Update members table - add new members and update team for existing ones
    const upsertMember = db.prepare(
      "INSERT INTO members (name, team) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET team = excluded.team"
    );

    // Same, but for sections that aren't teams: fills in a member we've never seen
    // without clobbering the team of one we have
    const insertMemberIfNew = db.prepare(
      "INSERT INTO members (name, team) VALUES (?, ?) ON CONFLICT(name) DO NOTHING"
    );

    // Insert or update holding
    const upsertHolding = db.prepare(`
      INSERT INTO holdings (member_id, asset, asset_type, first_added, status, last_seen)
      VALUES (?, ?, ?, DATE('now'), 'active', ?)
      ON CONFLICT(member_id, asset) DO UPDATE SET
        status = 'active',
        last_seen = ?
    `);

    // Insert into current holdings for tracking what's new vs. sold
    const trackCurrentHolding = db.prepare(
      "INSERT OR IGNORE INTO current_holdings (member_id, asset) VALUES (?, ?)"
    );

    // Get member id
    const getMemberId = db.prepare("SELECT id FROM members WHERE name = ?");
    const findHolding = db.prepare("SELECT id FROM holdings WHERE member_id = ? AND asset = ?");

    // Count how many new entries were added
    let newEntries = 0;
    let updatedEntries = 0;

    logger.info(`Processing ${holdings.length} holdings...`);

    holdings.forEach(({ name, team, asset, assetType, isTeamSection }) => {
      if (!asset || !asset.trim()) return; // Skip empty assets

      // Upsert the member
      if (isTeamSection === false) {
        insertMemberIfNew.run(name, team);
      } else {
        upsertMember.run(name, team);
      }

      // Get the member id
      const member = getMemberId.get(name);

      if (!member) {
        logger.error(`Skipping asset ${asset} for ${name}, member not found.`);
        return;
      }

      // Check if this holding already exists
      const existingHolding = findHolding.get(member.id, asset);

      // Update or insert the holding
      upsertHolding.run(member.id, asset, assetType || "crypto", today, today);

      // Track this in our current holdings table
      trackCurrentHolding.run(member.id, asset);

      // Count as new or updated
      if (!existingHolding) {
        newEntries++;
      } else {
        updatedEntries++;
      }
    });

    // Mark any holdings not seen today as inactive (sold/removed)
    const markInactiveHoldings = db.prepare(`
      UPDATE holdings
      SET status = 'inactive'
      WHERE status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM current_holdings
        WHERE current_holdings.member_id = holdings.member_id
        AND current_holdings.asset = holdings.asset
      )
    `);

    const inactiveResult = markInactiveHoldings.run();

    // Commit the transaction
    db.exec('COMMIT');
    logger.info(`Database updated: ${newEntries} new holdings added, ${updatedEntries} existing holdings updated.`);
    logger.info(`${inactiveResult.changes} holdings marked as inactive (sold/removed).`);

    return { newEntries, updatedEntries, deactivated: inactiveResult.changes };

  } catch (error) {
    // Rollback on error
    db.exec('ROLLBACK');
    logger.error('Error updating database:', error);
    throw error;
  }
}

// Only written on a successful scrape, so the dashboard's "last updated" stamp stops
// advancing the moment the data does. sourceNote is the page's own freshness line,
// which catches the other staleness: Blockworks themselves not updating.
function writeMetadata(result) {
  fs.writeFileSync(
    path.resolve(process.cwd(), "data/metadata.json"),
    JSON.stringify({
      lastUpdated: new Date().toISOString(),
      recordCount: result.holdings.length,
      strategy: result.strategy,
      sourceNote: result.sourceNote,
      warnings: result.warnings,
    })
  );
}

// Run the scraper
(async () => {
  let page = null;
  const record = { job: "scrape", ok: false };

  try {
    initializeDatabase();

    page = await fetchDisclosuresPage({ urls: BLOCKWORKS_URLS, log: message => logger.info(message) });
    record.url = page.url;

    const result = parseDisclosures(page.html, { log: message => logger.info(message) });

    record.strategy = result.strategy;
    record.scraped = result.holdings.length;
    record.sourceNote = result.sourceNote;
    record.attempts = result.attempts.map(a => `${a.name}=${a.count}`).join(",");
    if (result.warnings.length) record.warnings = result.warnings;

    if (result.sourceNote) logger.info(`Source says: "${result.sourceNote}"`);
    logger.info(`Strategy results: ${record.attempts}`);
    logger.info(`Extracted ${result.holdings.length} holdings in total`);

    if (result.holdings.length === 0) saveFailedPage(page.html);

    assertScrapeIsSane(result.holdings);

    // Snapshot the file before we touch it, so a bad write is recoverable
    backupDatabase(DB_FILE, { logger });

    const counts = saveToDatabase(result.holdings);
    Object.assign(record, counts);

    writeMetadata(result);
    writeSnapshot(db, { meta: { strategy: result.strategy, sourceNote: result.sourceNote }, logger });

    // Print statistics about the database
    const stats = {
      totalHoldings: db.prepare("SELECT COUNT(*) as count FROM holdings").get().count,
      activeHoldings: db.prepare("SELECT COUNT(*) as count FROM holdings WHERE status = 'active'").get().count,
      inactiveHoldings: db.prepare("SELECT COUNT(*) as count FROM holdings WHERE status = 'inactive'").get().count,
      totalMembers: db.prepare("SELECT COUNT(*) as count FROM members").get().count
    };

    logger.info("Database Statistics:");
    logger.info(`Total Members: ${stats.totalMembers}`);
    logger.info(`Total Holdings (all-time): ${stats.totalHoldings}`);
    logger.info(`Currently Active Holdings: ${stats.activeHoldings}`);
    logger.info(`Inactive Holdings (sold/removed): ${stats.inactiveHoldings}`);

    Object.assign(record, { ok: true, active: stats.activeHoldings, members: stats.totalMembers });

    // A non-DOM strategy still counts as success, but someone should look at it
    if (result.strategy && result.strategy !== "dom") {
      logger.warn(`Data came from the "${result.strategy}" fallback reader, not the primary one. The page layout has changed.`);
    }

  } catch (error) {
    logger.error(`Error running scraper: ${error.message}`);
    record.error = error.message;
    if (page) saveFailedPage(page.html);
    // Fail the job. This used to exit 0, so a dead scraper looked healthy.
    process.exitCode = 1;
  } finally {
    db.close();
    record.warningCount = logger.counts.warn;
    appendRunRecord(record);
    await logger.close();
  }
})();
