const fs = require("fs");
const path = require("path");

// Corrections for prices that were stored wrong.
//
// The prices table is append-only history, and it lives only in the binary database:
// the committed snapshot deliberately doesn't carry it. So a bad stretch of prices
// can't be fixed by editing a text file, and a pull request carrying a rewritten
// holdings.db would conflict with the daily data commit every morning and could not
// be reviewed.
//
// Instead each correction is a committed JSON file listing the exact rows to change:
// the row id and timestamp, the bad price it must still hold, and the replacement.
// The daily workflow applies them after collecting prices, so the repaired database
// goes out in the normal data commit. Applying is all-or-nothing and idempotent: rows
// already corrected are skipped, and a row holding anything other than the expected
// bad price stops the run before anything is written.

const CORRECTIONS_DIR = process.env.PRICE_CORRECTIONS_DIR || "data/price-corrections";

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Read every corrections file in `dir`, in name order. Throws on a file that doesn't
 * have the expected shape - a half-understood correction must not be half-applied.
 */
function readCorrections({ dir = CORRECTIONS_DIR } = {}) {
  const target = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(target)) return [];

  return fs.readdirSync(target)
    .filter(name => name.endsWith(".json"))
    .sort()
    .map(name => {
      const file = path.join(target, name);
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));

      if (typeof parsed.asset !== "string" || !parsed.asset) throw new Error(`${name}: no asset`);
      if (typeof parsed.source !== "string" || !parsed.source) throw new Error(`${name}: no source`);
      if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) throw new Error(`${name}: no rows`);

      parsed.rows.forEach((row, i) => {
        if (!Number.isInteger(row.id)) throw new Error(`${name}: row ${i} has no integer id`);
        if (typeof row.date !== "string") throw new Error(`${name}: row ${i} has no date`);
        if (!isPositiveNumber(row.from) || !isPositiveNumber(row.to)) {
          throw new Error(`${name}: row ${i} needs positive "from" and "to" prices`);
        }
      });

      return { file: name, asset: parsed.asset, source: parsed.source, rows: parsed.rows };
    });
}

/**
 * Compare the corrections with what the database holds. Nothing is written.
 * Returns the rows still to change, how many are already corrected, and every row
 * that matches neither - any of those means the database isn't what the correction
 * was built against, and the whole set has to be refused.
 */
function planCorrections(db, corrections) {
  const read = db.prepare("SELECT id, asset, date, price, source FROM prices WHERE id = ?");
  const toApply = [];
  const problems = [];
  let alreadyApplied = 0;

  for (const correction of corrections) {
    for (const row of correction.rows) {
      const stored = read.get(row.id);
      const where = `${correction.file}: prices row ${row.id} (${correction.asset} ${row.date})`;

      if (!stored) {
        problems.push(`${where} is missing`);
      } else if (stored.asset !== correction.asset || stored.date !== row.date) {
        problems.push(`${where} is ${stored.asset} ${stored.date} in the database`);
      } else if (stored.price === row.to && stored.source === correction.source) {
        alreadyApplied++;
      } else if (stored.price === row.from) {
        toApply.push({ id: row.id, from: row.from, to: row.to, source: correction.source });
      } else {
        problems.push(`${where} holds ${stored.price} (${stored.source}); expected ${row.from} or the correction ${row.to}`);
      }
    }
  }

  return { toApply, alreadyApplied, problems };
}

/**
 * Write a plan from planCorrections in one transaction. Each update is guarded on the
 * old price, so a row that changed since planning rolls the whole set back.
 */
function applyCorrections(db, plan) {
  if (plan.problems.length > 0) {
    throw new Error(`Refusing to apply corrections: ${plan.problems.length} rows don't match`);
  }

  const update = db.prepare("UPDATE prices SET price = ?, source = ? WHERE id = ? AND price = ?");
  const write = db.transaction(rows => {
    for (const row of rows) {
      if (update.run(row.to, row.source, row.id, row.from).changes !== 1) {
        throw new Error(`prices row ${row.id} changed while being corrected; nothing was written`);
      }
    }
    return rows.length;
  });

  return write(plan.toApply);
}

/**
 * The point in a time-ordered [[ms, price], ...] series closest to `t`, or null if the
 * closest is further than `maxGapMs` away.
 */
function nearestPoint(series, t, maxGapMs) {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }

  let best = null;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= series.length) continue;
    if (!best || Math.abs(series[i][0] - t) < Math.abs(best[0] - t)) best = series[i];
  }
  return best && Math.abs(best[0] - t) <= maxGapMs ? best : null;
}

/** JSON with one correction row per line, so a review diff reads row by row. */
function formatCorrectionsFile(header, rows) {
  const head = JSON.stringify(header, null, 2).replace(/\n}$/, "");
  const body = rows.map(row => `    ${JSON.stringify(row)}`).join(",\n");
  return `${head},\n  "rows": [\n${body}\n  ]\n}\n`;
}

module.exports = {
  CORRECTIONS_DIR,
  readCorrections,
  planCorrections,
  applyCorrections,
  nearestPoint,
  formatCorrectionsFile,
};
