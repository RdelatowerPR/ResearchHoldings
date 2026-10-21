// Collect prices for everything currently held, into the prices table.
//
// Run: node scripts/fetchPrices.js
// Env: COINGECKO_API_KEY    Pro key; falls back to the keyless endpoint without one,
//                           and demotes itself automatically if the key is rejected
//      ALPHA_VANTAGE_API_KEY  needed for equities; without it none is priced
//      HOLDINGS_DB          override the database path
//
// Price failures are per-asset and non-fatal by design - a missing quote should not
// cost us the run. But each equity left unpriced is a warning, and a run that prices
// no equity at all while equities are held fails. See docs/RUNBOOK.md.

const Database = require("better-sqlite3");
const { loadEnv } = require("./lib/loadEnv");
const { createLogger, appendRunRecord } = require("./lib/logger");
const { CoinGeckoClient } = require("./lib/coingecko");
const { fetchEquityPrices, equityOutage } = require("./lib/alphaVantage");

loadEnv();

// Overridable so a test run can point at a scratch copy of the database.
const DB_FILE = process.env.HOLDINGS_DB || "data/holdings.db";

const logger = createLogger("prices");

// Initialize SQLite database
const db = new Database(DB_FILE);

// API Configurations
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY; // set as a repo secret, passed in by the workflow

// Handles the Pro/keyless host split, and demotes itself if the key stops working
const coingecko = new CoinGeckoClient({ apiKey: process.env.COINGECKO_API_KEY, logger });

// Function to set up the prices table
function initializeDatabase() {
  logger.info("Initializing database for price tracking...");
  
  // Create prices table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset TEXT NOT NULL,
      price REAL NOT NULL,
      date TEXT NOT NULL,
      source TEXT NOT NULL
    );
    
    -- Create index for faster querying by asset and date
    CREATE INDEX IF NOT EXISTS idx_prices_asset ON prices(asset);
    CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);
  `);
  
  // Create a token mapping table for CoinGecko IDs
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_mappings (
      asset TEXT PRIMARY KEY,
      coingecko_id TEXT,
      symbol TEXT,
      last_updated TEXT
    );
  `);
}

// Sleep function for rate limiting
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries, backoff and the key failsafe all live in the client now
function makeApiCall(pathname, params, maxRetries = 3) {
  return coingecko.get(pathname, params, { maxRetries });
}

// Function to map crypto symbols to CoinGecko IDs
async function mapCryptoIds() {
  logger.info("Mapping crypto symbols to CoinGecko IDs...");
  
  // Get all active crypto assets
  const assets = db.prepare("SELECT DISTINCT asset FROM holdings WHERE asset_type = 'crypto' AND status = 'active'").all();
  
  // Get existing mappings
  const existingMappings = db.prepare("SELECT asset FROM token_mappings").all().map(row => row.asset);
  
  // Filter to only process assets that don't have mappings
  const unmappedAssets = assets.filter(asset => !existingMappings.includes(asset.asset));

  // Create a mapping table if needed
  const upsertMapping = db.prepare(`
    INSERT INTO token_mappings (asset, coingecko_id, symbol, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(asset) DO UPDATE SET 
      coingecko_id = excluded.coingecko_id,
      symbol = excluded.symbol,
      last_updated = excluded.last_updated
  `);
  
  // Assets that need manual mapping
  const manualMappings = {
    'BTC': 'bitcoin',
    'ETH': 'ethereum',
    'SOL': 'solana',
    'AVAX': 'avalanche-2',
    'LINK': 'chainlink',
    'UNI': 'uniswap',
    'AAVE': 'aave',
    'OP': 'optimism',
    'TIA': 'celestia',
    'SUI': 'sui',
    'APT': 'aptos',
    'RNDR': 'render-token',
    'HYPE': 'hyperliquid',
    'DEGEN': 'degen-token',
    'IMX': 'immutable-x',
    'MKR': 'maker',
    'MSTR': 'microstrategy',
    'AKT': 'akash-network',
    'AERO': 'aerodrome-finance',
    'BONK': 'bonk',
    'ENA': 'ethena',
    'HOOD': 'robinhood',
    'JTO': 'jito-governance-token',
    'KMNO': 'kamino',
    'LFNTY': 'lifinity',
    'LDO': 'lido-dao',
    'MORPHO': 'morpho',
    'MOTO': 'motoverse',
    'PENGU': 'pudgy-penguins',
    'PHNIX': 'phoenix-token',
    'PRIME': 'echelon-prime',
    'SCRAP': 'scrap',
    'TNSR': 'tensor',
    'XAI': 'xai',
    'XRP': 'ripple',
    'ZYN': 'zynergy'
    // Add more mappings as needed
  };

  // Nothing above ever revisits a stored mapping, so one bad guess is kept forever:
  // until 2026-08-17 HYPE and PENGU were priced as other tokens (a flat 0.050472 and
  // 7.78 every day for 17 months) and KMNO not at all. Those stored rows are repaired
  // by data/price-corrections/. These ids were each checked against the CoinGecko API
  // and overwrite whatever is stored. Only add an entry here after confirming
  // /coins/<id> resolves to the right asset.
  const verifiedOverrides = {
    'HYPE': 'hyperliquid',
    'KMNO': 'kamino',
    'PENGU': 'pudgy-penguins'
  };

  const readMapping = db.prepare("SELECT coingecko_id FROM token_mappings WHERE asset = ?");
  for (const [asset, coingeckoId] of Object.entries(verifiedOverrides)) {
    const current = readMapping.get(asset);
    if (current && current.coingecko_id !== coingeckoId) {
      upsertMapping.run(asset, coingeckoId, asset.toLowerCase(), new Date().toISOString());
      logger.info(`Corrected mapping for ${asset}: ${current.coingecko_id} -> ${coingeckoId}`);
    }
  }

  if (unmappedAssets.length === 0) {
    logger.info("All assets are already mapped. Skipping mapping step.");
    return;
  }

  logger.info(`Need to map ${unmappedAssets.length} assets`);

  // Process each asset
  for (const { asset } of unmappedAssets) {
    // Check if we need to respect rate limits
    await sleep(coingecko.limits.requestDelay);
    
    try {
      // Check if we have a manual mapping
      if (manualMappings[asset]) {
        upsertMapping.run(
          asset,
          manualMappings[asset],
          asset.toLowerCase(),
          new Date().toISOString()
        );
        logger.info(`Mapped ${asset} to ${manualMappings[asset]} (manual)`);
        continue;
      }
      
      // Otherwise, try to search for it, with rate limit handling
      try {
        const search = await makeApiCall("/search", { query: asset });
        
        if (search.data && search.data.coins && search.data.coins.length > 0) {
          // Take the first match as the most likely
          const coin = search.data.coins[0];
          upsertMapping.run(
            asset,
            coin.id,
            coin.symbol,
            new Date().toISOString()
          );
          logger.info(`Mapped ${asset} to ${coin.id} (auto)`);
        } else {
          logger.info(`No CoinGecko mapping found for ${asset}`);
        }
      } catch (error) {
        logger.error(`Error searching for ${asset}:`, error.message);
      }
      
    } catch (error) {
      logger.error(`Error mapping ${asset}:`, error.message);
    }
  }
}

// Function to fetch cryptocurrency prices
async function fetchCryptoPrices() {
  logger.info("Fetching cryptocurrency prices...");
  
  // Get all mapped assets
  const mappedTokens = db.prepare("SELECT asset, coingecko_id FROM token_mappings").all();
  
  if (mappedTokens.length === 0) {
    logger.info("No mapped crypto tokens found, run mapCryptoIds first");
    return;
  }
  
  logger.info(`Found ${mappedTokens.length} tokens to fetch prices for`);
  
  // Batch size follows the tier: generous with a key, conservative without one
  const batchSize = coingecko.limits.batchSize;
  for (let i = 0; i < mappedTokens.length; i += batchSize) {
    // Respect rate limits between batches
    if (i > 0) {
      logger.info(`Waiting for rate limit before processing next batch...`);
      await sleep(coingecko.limits.requestDelay);
    }
    
    const batch = mappedTokens.slice(i, i + batchSize);
    const coinIds = batch.map(t => t.coingecko_id).join(',');
    
    logger.info(`Processing batch ${i/batchSize + 1}/${Math.ceil(mappedTokens.length/batchSize)}: ${coinIds}`);
    
    try {
      const response = await makeApiCall("/simple/price", { 
        ids: coinIds, 
        vs_currencies: "usd",
        include_24hr_change: true
      });
      
      const insertPrice = db.prepare(
        "INSERT INTO prices (asset, price, date, source) VALUES (?, ?, ?, ?)"
      );
      
      let foundCount = 0;
      batch.forEach(({ asset, coingecko_id }) => {
        const price = response.data[coingecko_id]?.usd || null;
        if (price !== null) {
          const now = new Date().toISOString();
          insertPrice.run(asset, price, now, 'coingecko');
          foundCount++;
          logger.info(`Stored price for ${asset} (${coingecko_id}): $${price}`);
        } else {
          logger.info(`Price not found for ${asset} (${coingecko_id})`);
        }
      });
      
      logger.info(`Batch complete: ${foundCount}/${batch.length} prices found`);
      
    } catch (error) {
      logger.error("Error fetching crypto prices:", error.message);
      if (error.response) {
        logger.error("Response data:", error.response.data);
        logger.error("Status:", error.response.status);
      }
    }
  }
}

// Function to fetch cryptocurrency prices using a fallback approach
// This alternative method gets one token at a time if the batch approach fails
async function fetchCryptoPricesFallback() {
  logger.info("Using fallback method to fetch crypto prices one by one...");
  
  const mappedTokens = db.prepare("SELECT asset, coingecko_id FROM token_mappings").all();
  
  const insertPrice = db.prepare(
    "INSERT INTO prices (asset, price, date, source) VALUES (?, ?, ?, ?)"
  );
  
  for (const { asset, coingecko_id } of mappedTokens) {
    // Respect rate limits between requests
    await sleep(coingecko.limits.requestDelay);
    
    try {
      logger.info(`Fetching price for ${asset} (${coingecko_id})...`);
      const response = await makeApiCall("/simple/price", { 
        ids: coingecko_id, 
        vs_currencies: "usd"
      });
      
      const price = response.data[coingecko_id]?.usd || null;
      if (price !== null) {
        const now = new Date().toISOString();
        insertPrice.run(asset, price, now, 'coingecko');
        logger.info(`Stored price for ${asset}: $${price}`);
      } else {
        logger.info(`Price not found for ${asset}`);
      }
      
    } catch (error) {
      logger.error(`Error fetching price for ${asset}:`, error.message);
    }
  }
}

// Function to fetch equity prices from Alpha Vantage. It replies 200 even when it
// sends no quote, so each equity left unpriced is a warning quoting the reply.
function fetchStockPrices() {
  logger.info("Fetching stock prices...");
  return fetchEquityPrices({ db, logger, apiKey: ALPHA_VANTAGE_API_KEY });
}

// Function to run everything
async function main() {
  const record = { job: "prices", ok: false };
  const pricesBefore = db.prepare("SELECT COUNT(*) as count FROM prices").get().count;

  try {
    // Confirm the key before the run leans on it. A rejected key demotes the client
    // to the keyless endpoint here rather than failing every request downstream.
    await coingecko.verify();

    // Begin transaction for database setup
    db.exec('BEGIN TRANSACTION');
    initializeDatabase();
    db.exec('COMMIT');
    
    // Map crypto symbols to CoinGecko IDs
    await mapCryptoIds();
    
    // Try the regular batch approach first
    try {
      await fetchCryptoPrices();
    } catch (error) {
      logger.error("Batch approach failed, trying fallback method:", error.message);
      await fetchCryptoPricesFallback();
    }
    
    // Fetch stock prices
    const equities = await fetchStockPrices();
    
    // Print some statistics
    const stats = {
      totalPrices: db.prepare("SELECT COUNT(*) as count FROM prices").get().count,
      uniqueAssets: db.prepare("SELECT COUNT(DISTINCT asset) as count FROM prices").get().count,
      latestDate: db.prepare("SELECT MAX(date) as latest FROM prices").get().latest
    };
    
    logger.info("Price Database Statistics:");
    logger.info(`Total Price Records: ${stats.totalPrices}`);
    logger.info(`Unique Assets With Prices: ${stats.uniqueAssets}`);
    logger.info(`Latest Price Date: ${stats.latestDate}`);

    Object.assign(record, {
      ok: true,
      stored: stats.totalPrices - pricesBefore,
      pricedAssets: stats.uniqueAssets,
      equitiesActive: equities.active,
      equitiesStored: equities.stored,
      equitiesMissing: equities.missing.length ? equities.missing.map(m => m.asset) : undefined,
    });

    // Losing a whole source fails the run even though the crypto prices stored fine.
    // The job goes red, so the workflow opens the collector-failure issue, and the
    // crypto prices already written are still committed with it.
    const outage = equityOutage(equities);
    if (outage) {
      logger.error(outage);
      Object.assign(record, { ok: false, error: outage });
      process.exitCode = 1;
    }

    // A demotion means prices were collected, slowly, on a dead key - the run looks
    // fine and the key still needs replacing. Say so in a way that survives the logs.
    if (coingecko.status.demotionReason) {
      logger.warn(
        `ACTION NEEDED: the CoinGecko key is not working (${coingecko.status.demotionReason}). This run completed on the keyless endpoint.`
      );
    }

  } catch (error) {
    logger.error("Error in main function:", error);
    db.exec('ROLLBACK');
    record.error = error.message;
    // Per-asset failures are handled inline; reaching here means the run itself broke
    process.exitCode = 1;
  } finally {
    db.close();
    Object.assign(record, {
      coingecko: coingecko.status.mode,
      keyDemoted: coingecko.status.demotionReason || undefined,
      warningCount: logger.counts.warn,
    });
    appendRunRecord(record);
    await logger.close();
  }
}

// Run the script
main();