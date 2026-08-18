// Recover holdings for dates the collector missed, from the Wayback Machine.
//
// The collector went dark on 2025-06-19 and wrote nothing until 2026-08-17. That data
// was never collected, but the pages themselves were archived, and the readers in
// lib/parseDisclosures.js handle the older layouts - so the gap is partly fillable.
//
// Observations land in `holdings_history`, one row per (capture date, member, asset).
// That table is additive and point-in-time; it does not touch `holdings`, which the
// dashboard reads as current state. Re-running is safe: captures already imported are
// skipped, and rows are unique per date.
//
// Run: node scripts/backfillFromArchive.js [--from YYYYMMDD] [--to YYYYMMDD] [--dry-run]

const axios = require("axios");
const Database = require("better-sqlite3");

const { parseDisclosures } = require("./lib/parseDisclosures");
const { createLogger, appendRunRecord } = require("./lib/logger");
const { backupDatabase } = require("./lib/backup");
const { createHistoryTable, recordObservations, importedDates } = require("./lib/history");

const DB_FILE = process.env.HOLDINGS_DB || "data/holdings.db";

// Both hosts: the site moved from .co to .com partway through the outage
const ARCHIVED_URLS = [
  "blockworks.com/financial-disclosures",
  "blockworks.co/financial-disclosures",
];

// Default window: the day the collector went dark, to the day it came back
const DEFAULT_FROM = "20250619";
const DEFAULT_TO = "20260817";

const WAYBACK_DELAY = 3000; // be a good citizen

const logger = createLogger("backfill");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const DRY_RUN = process.argv.includes("--dry-run");

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Ask the Wayback CDX index which captures exist, newest content only. */
async function listCaptures(url, from, to) {
  const endpoint = "http://web.archive.org/cdx/search/cdx";
  const { data } = await axios.get(endpoint, {
    timeout: 60000,
    params: {
      url,
      output: "json",
      fl: "timestamp,statuscode,digest",
      filter: "statuscode:200",
      collapse: "digest", // one row per distinct page content
      from,
      to,
    },
  });

  if (!Array.isArray(data) || data.length < 2) return [];
  return data.slice(1).map(([timestamp]) => ({ timestamp, url }));
}

/** Fetch the raw archived page. The id_ suffix asks for it without Wayback's banner. */
async function fetchCapture({ timestamp, url }) {
  const { data } = await axios.get(`https://web.archive.org/web/${timestamp}id_/https://${url}`, {
    timeout: 60000,
    headers: { "User-Agent": "ResearchHoldings-backfill/1.0 (+https://github.com/RdelatowerPR/ResearchHoldings)" },
  });
  return String(data);
}

const asDate = timestamp =>
  `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;

(async () => {
  const db = new Database(DB_FILE);
  const record = { job: "backfill", ok: false };

  try {
    const from = arg("from", DEFAULT_FROM);
    const to = arg("to", DEFAULT_TO);
    logger.info(`Backfilling ${asDate(from)} to ${asDate(to)}${DRY_RUN ? " (dry run)" : ""}`);

    createHistoryTable(db);
    if (!DRY_RUN) backupDatabase(DB_FILE, { logger });

    // Gather captures across both hosts, oldest first, one per calendar day
    const captures = [];
    for (const url of ARCHIVED_URLS) {
      const found = await listCaptures(url, from, to);
      logger.info(`${url}: ${found.length} captures`);
      captures.push(...found);
      await sleep(WAYBACK_DELAY);
    }

    captures.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const alreadyHave = importedDates(db);

    let imported = 0;
    let skipped = 0;
    const summary = [];

    for (const capture of captures) {
      const date = asDate(capture.timestamp);

      if (alreadyHave.has(date)) {
        logger.info(`${date}: already imported, skipping`);
        skipped++;
        continue;
      }

      let html;
      try {
        html = await fetchCapture(capture);
      } catch (error) {
        logger.warn(`${date}: fetch failed (${error.message})`);
        await sleep(WAYBACK_DELAY);
        continue;
      }

      const result = parseDisclosures(html);

      if (result.holdings.length === 0) {
        logger.warn(`${date}: nothing parsed from ${capture.url} - skipping rather than recording a gap as empty`);
        await sleep(WAYBACK_DELAY);
        continue;
      }

      const members = new Set(result.holdings.map(h => h.name)).size;
      logger.info(
        `${date}: ${result.holdings.length} holdings, ${members} members, via "${result.strategy}" (${capture.url})`
      );

      if (!DRY_RUN) {
        recordObservations(db, date, result.holdings, `archive.org/${capture.timestamp}`);
      }

      alreadyHave.add(date);
      imported++;
      summary.push({ date, holdings: result.holdings.length, members });

      await sleep(WAYBACK_DELAY);
    }

    const total = db.prepare("SELECT COUNT(*) as count FROM holdings_history").get().count;
    const dates = db.prepare("SELECT COUNT(DISTINCT observed_date) as count FROM holdings_history").get().count;

    logger.info(`Imported ${imported} captures (${skipped} already present).`);
    logger.info(`holdings_history now holds ${total} observations across ${dates} dates.`);

    Object.assign(record, { ok: true, imported, skipped, observations: total, dates });
    if (summary.length) record.captures = summary.map(s => `${s.date}:${s.holdings}`).join(",");

  } catch (error) {
    logger.error(`Backfill failed: ${error.message}`);
    record.error = error.message;
    process.exitCode = 1;
  } finally {
    db.close();
    appendRunRecord(record);
    await logger.close();
  }
})();
