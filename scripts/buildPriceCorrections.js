// Build a price-corrections file for an asset that was priced as the wrong token.
//
// Until 2026-08-17 HYPE and PENGU were mapped to the wrong CoinGecko ids, and every
// daily run stored the other token's (unchanging) price for them. This rebuilds those
// rows from the right id's own history: for each stored row, the CoinGecko hourly price
// nearest the row's timestamp. The result is a file in data/price-corrections/ for
// applyPriceCorrections.js to apply - this script only reads the database.
//
// Before writing anything it checks the replacements three ways, and refuses if any
// check fails:
//   - every bad row has a CoinGecko point within 90 minutes of its own timestamp
//   - the same method reproduces the rows stored since the mapping was fixed (median
//     difference under 1%), which proves the id and the method match the collector
//   - optionally, the prices sit inside Hyperliquid's own daily low-high range for
//     that day (98% of rows, 1% tolerance), an independent second source
//
// Needs a Pro COINGECKO_API_KEY: the keyless endpoint only serves the last 365 days.
//
// Run: node scripts/buildPriceCorrections.js --asset HYPE --coingecko-id hyperliquid \
//        --bad-price 0.050472 --before 2026-08-17T21:18:00.190Z [--hyperliquid-coin HYPE] [--out file]
// Env: COINGECKO_API_KEY, HOLDINGS_DB

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const Database = require("better-sqlite3");

const { loadEnv } = require("./lib/loadEnv");
const { createLogger } = require("./lib/logger");
const { CoinGeckoClient } = require("./lib/coingecko");
const { CORRECTIONS_DIR, nearestPoint, formatCorrectionsFile } = require("./lib/priceCorrections");

loadEnv();

const DB_FILE = process.env.HOLDINGS_DB || "data/holdings.db";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_GAP = 90 * 60 * 1000; // CoinGecko serves hourly points for ranges up to 90 days
const CHUNK = 85 * DAY;
const KNOWN_GOOD_WINDOW = 60 * DAY;
const MAX_KNOWN_GOOD_MEDIAN = 1; // percent
const HYPERLIQUID_TOLERANCE = 0.01;
const MIN_INSIDE_HYPERLIQUID = 0.98;

const logger = createLogger("corrections-build");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const ms = iso => Date.parse(iso);
const iso = t => new Date(t).toISOString();
const sleep = t => new Promise(r => setTimeout(r, t));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function coingeckoSeries(coingecko, id, from, to) {
  const points = new Map();
  for (let start = from; start < to; start += CHUNK) {
    const end = Math.min(start + CHUNK, to);
    const { data } = await coingecko.get(`/coins/${id}/market_chart/range`, {
      vs_currency: "usd",
      from: Math.floor(start / 1000),
      to: Math.floor(end / 1000),
    });
    for (const [t, price] of data.prices || []) points.set(t, price);
    await sleep(coingecko.limits.requestDelay);
  }
  return [...points.entries()].sort((a, b) => a[0] - b[0]);
}

async function hyperliquidDays(coin, from, to) {
  const { data } = await axios.post("https://api.hyperliquid.xyz/info", {
    type: "candleSnapshot",
    req: { coin, interval: "1d", startTime: from, endTime: to },
  }, { timeout: 60000 });
  return new Map(data.map(c => [iso(c.t).slice(0, 10), { low: Number(c.l), high: Number(c.h) }]));
}

(async () => {
  const asset = arg("asset");
  const coingeckoId = arg("coingecko-id");
  const badPrice = Number(arg("bad-price"));
  const before = arg("before");
  const hyperliquidCoin = arg("hyperliquid-coin");

  if (!asset || !coingeckoId || !(badPrice > 0) || !before || Number.isNaN(ms(before))) {
    logger.error("Usage: --asset X --coingecko-id id --bad-price N --before ISO-time [--hyperliquid-coin C] [--out file]");
    process.exitCode = 1;
    return logger.close();
  }

  const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });

  try {
    const coingecko = new CoinGeckoClient({ apiKey: process.env.COINGECKO_API_KEY, logger });
    await coingecko.verify();
    if (coingecko.mode !== "pro") throw new Error("A working Pro COINGECKO_API_KEY is required for history older than 365 days");

    const rows = db.prepare("SELECT id, date, price FROM prices WHERE asset = ? AND date < ? ORDER BY date").all(asset, before);
    if (rows.length === 0) throw new Error(`No ${asset} prices stored before ${before}`);

    // Only ever replace the bad value. A row with any other price is real data, or a
    // different problem, and this script must not paper over it.
    const unexpected = rows.filter(r => r.price !== badPrice);
    if (unexpected.length > 0) {
      throw new Error(`${unexpected.length} ${asset} rows before ${before} hold something other than ${badPrice}, e.g. row ${unexpected[0].id} = ${unexpected[0].price}`);
    }

    const from = ms(rows[0].date) - DAY;
    const knownGoodTo = Math.min(ms(before) + KNOWN_GOOD_WINDOW, Date.now());
    const series = await coingeckoSeries(coingecko, coingeckoId, from, knownGoodTo);
    logger.info(`CoinGecko ${coingeckoId}: ${series.length} points, ${iso(series[0][0])} .. ${iso(series[series.length - 1][0])}`);

    const corrections = rows.map(row => {
      const point = nearestPoint(series, ms(row.date), MAX_GAP);
      if (!point) throw new Error(`No CoinGecko price within 90 minutes of row ${row.id} (${row.date})`);
      return { id: row.id, date: row.date, from: row.price, to: Number(point[1].toPrecision(8)), at: iso(point[0]) };
    });

    // The method, run on rows the collector stored after the mapping was fixed
    const good = db.prepare("SELECT date, price FROM prices WHERE asset = ? AND date >= ? AND date <= ? ORDER BY date")
      .all(asset, before, iso(knownGoodTo));
    const deviations = good
      .map(row => ({ row, point: nearestPoint(series, ms(row.date), MAX_GAP) }))
      .filter(({ point }) => point)
      .map(({ row, point }) => Math.abs(point[1] / row.price - 1) * 100);
    if (deviations.length < 5) throw new Error(`Only ${deviations.length} known-good ${asset} rows to check the method against`);
    const knownGood = {
      rows: deviations.length,
      medianPct: Number(median(deviations).toFixed(2)),
      maxPct: Number(Math.max(...deviations).toFixed(2)),
    };
    logger.info(`Method check on ${knownGood.rows} rows stored since the fix: median ${knownGood.medianPct}%, max ${knownGood.maxPct}%`);
    if (knownGood.medianPct > MAX_KNOWN_GOOD_MEDIAN) {
      throw new Error(`CoinGecko ${coingeckoId} doesn't reproduce the prices stored since the fix (median ${knownGood.medianPct}%)`);
    }

    const checks = { knownGood };
    if (hyperliquidCoin) {
      const days = await hyperliquidDays(hyperliquidCoin, from, ms(before) + DAY);
      const inside = corrections.filter(c => {
        const day = days.get(c.date.slice(0, 10));
        return day && c.to >= day.low * (1 - HYPERLIQUID_TOLERANCE) && c.to <= day.high * (1 + HYPERLIQUID_TOLERANCE);
      }).length;
      checks.hyperliquid = { coin: hyperliquidCoin, insideDailyRange: inside, of: corrections.length };
      logger.info(`Hyperliquid ${hyperliquidCoin}: ${inside} of ${corrections.length} inside the day's low-high range`);
      if (inside < corrections.length * MIN_INSIDE_HYPERLIQUID) {
        throw new Error(`Only ${inside} of ${corrections.length} corrected prices fall inside Hyperliquid's daily range`);
      }
    }

    const first = rows[0].date.slice(0, 10);
    const last = rows[rows.length - 1].date.slice(0, 10);
    const out = arg("out", `${CORRECTIONS_DIR}/${asset}-${first}-to-${last}.json`);
    const header = {
      asset,
      source: "coingecko-backfill",
      why: `Priced as the wrong CoinGecko token until the mapping was corrected to ${coingeckoId} at ${before}: every row before then holds ${badPrice}.`,
      coingeckoId,
      method: "CoinGecko /coins/{id}/market_chart/range (hourly), the point nearest each row's own timestamp",
      builtAt: new Date().toISOString(),
      checks,
    };

    fs.mkdirSync(path.dirname(path.resolve(process.cwd(), out)), { recursive: true });
    fs.writeFileSync(out, formatCorrectionsFile(header, corrections));
    const prices = corrections.map(c => c.to);
    logger.info(`Wrote ${corrections.length} corrections to ${out}: ${first} ${corrections[0].to} .. ${last} ${corrections[corrections.length - 1].to}, range ${Math.min(...prices)} .. ${Math.max(...prices)}`);
  } catch (error) {
    logger.error(`Building corrections failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
    await logger.close();
  }
})();
