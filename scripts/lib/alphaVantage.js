const axios = require("axios");

// Equity prices from Alpha Vantage's GLOBAL_QUOTE, one request per symbol.
//
// Alpha Vantage answers HTTP 200 whether or not a quote comes back. A spent rate
// limit or daily allowance arrives as {"Information": "..."} (older replies used
// "Note"), a bad call as {"Error Message": "..."}, an unknown symbol as an empty
// "Global Quote". The collector used to log all of these as "Price not found", with
// no reason and no warning, so on 2026-09-21 no equity priced and the run still
// recorded ok:true with zero warnings. Now each equity left without a price is a
// warning that quotes the reply, and equityOutage() decides when the run has failed.

const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

// Free tier: 5 requests a minute. A request that threw waits longer.
const REQUEST_DELAY = 15000;
const ERROR_DELAY = 30000;

// Where Alpha Vantage puts its reason for sending no data
const MESSAGE_FIELDS = ["Information", "Note", "Error Message"];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function excerpt(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text).slice(0, 200);
}

// Why a reply carried no usable price, in the API's own words when it gave any
function describeMissingQuote(data) {
  if (!data || typeof data !== "object") return `unexpected reply: ${excerpt(data)}`;

  for (const field of MESSAGE_FIELDS) {
    if (data[field]) return `${field}: ${data[field]}`;
  }

  const quote = data["Global Quote"];
  if (!quote) return `no "Global Quote" in the reply: ${excerpt(data)}`;
  if (Object.keys(quote).length === 0) return `empty "Global Quote" (unknown symbol?)`;
  return `"Global Quote" without a usable price: ${excerpt(quote)}`;
}

/**
 * Price every active equity, storing each quote that arrives.
 *
 * @param {object}   options
 * @param {object}   options.db       better-sqlite3 database with holdings and prices tables.
 * @param {object}   options.logger   Anything with info/warn/error. Each equity left
 *                                    without a price is one warn.
 * @param {string}  [options.apiKey]  Without one, every active equity goes unpriced.
 * @param {Function}[options.request] Injected for tests; defaults to axios.get.
 * @param {Function}[options.wait]    Injected for tests; defaults to a real sleep.
 * @returns {Promise<{active: number, stored: number, missing: {asset: string, reason: string}[]}>}
 */
async function fetchEquityPrices({
  db,
  logger,
  apiKey,
  request = (url, config) => axios.get(url, config),
  wait = sleep,
}) {
  const stocks = db.prepare("SELECT DISTINCT asset FROM holdings WHERE asset_type = 'equity' AND status = 'active'").all();
  const result = { active: stocks.length, stored: 0, missing: [] };

  const unpriced = (asset, reason) => {
    result.missing.push({ asset, reason });
    logger.warn(`No price for ${asset}: ${reason}`);
  };

  if (stocks.length === 0) {
    logger.info("No equity assets found");
    return result;
  }

  if (!apiKey) {
    for (const { asset } of stocks) unpriced(asset, "ALPHA_VANTAGE_API_KEY is not set");
    return result;
  }

  const insertPrice = db.prepare(
    "INSERT INTO prices (asset, price, date, source) VALUES (?, ?, ?, ?)"
  );

  for (const { asset } of stocks) {
    try {
      logger.info(`Fetching price for ${asset}...`);
      const response = await request(ALPHA_VANTAGE_URL, {
        params: { function: "GLOBAL_QUOTE", symbol: asset, apikey: apiKey },
      });

      const price = Number.parseFloat(response.data?.["Global Quote"]?.["05. price"]);
      if (Number.isFinite(price) && price > 0) {
        insertPrice.run(asset, price, new Date().toISOString(), "alphavantage");
        result.stored++;
        logger.info(`Stored stock price for ${asset}: $${price}`);
      } else {
        unpriced(asset, describeMissingQuote(response.data));
      }

      logger.info("Waiting for Alpha Vantage rate limit...");
      await wait(REQUEST_DELAY);
    } catch (error) {
      unpriced(asset, error.response ? `HTTP ${error.response.status} ${excerpt(error.response.data)}` : error.message);
      await wait(ERROR_DELAY);
    }
  }

  return result;
}

// Losing every equity quote fails the run: the crypto prices alone kept 2026-09-21
// looking healthy. Returns what to record as the failure, or null. Losing only some
// equities is not a failure; each of them is already a warning.
function equityOutage({ active, stored, missing = [] }) {
  if (active === 0 || stored > 0) return null;

  const first = missing[0];
  const reason = first && first.reason.length > 160 ? `${first.reason.slice(0, 157)}...` : first?.reason;
  const example = first ? ` (${first.asset}: ${reason})` : "";
  return `No equity prices stored: 0 of ${active} active equities priced${example}`;
}

module.exports = { fetchEquityPrices, equityOutage, describeMissingQuote, ALPHA_VANTAGE_URL, REQUEST_DELAY };
