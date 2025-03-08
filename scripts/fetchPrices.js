const axios = require("axios");
const Database = require("better-sqlite3");

// Initialize SQLite database
const db = new Database("data/holdings.db");

// API Configurations
const COINGECKO_API = "https://api.coingecko.com/api/v3";
const ALPHA_VANTAGE_API_KEY = "5EKEPHEMLJHCWOUN"; // Replace with your actual API key
const ALPHA_VANTAGE_URL = "https://www.alphavantage.co/query";

// Rate limit configuration
const COINGECKO_RATE_LIMIT = {
  maxRequests: 25,  // Maximum 25 requests
  perMinute: 60000, // per minute (60000 ms)
  requestDelay: 3000 // 3 seconds between requests
};

// Function to set up the prices table
function initializeDatabase() {
  console.log("Initializing database for price tracking...");
  
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

// Function to make API calls with retry logic
async function makeApiCall(url, params, maxRetries = 3) {
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      return await axios.get(url, { params });
    } catch (error) {
      retries++;
      const status = error.response?.status;
      
      // If we hit rate limits (429) or server errors (5xx)
      if (status === 429 || (status >= 500 && status < 600)) {
        const delay = COINGECKO_RATE_LIMIT.requestDelay * Math.pow(2, retries);
        console.log(`Rate limit hit or server error. Waiting for ${delay/1000} seconds before retry ${retries}/${maxRetries}`);
        await sleep(delay);
      } else {
        // For other errors, throw immediately
        throw error;
      }
    }
  }
  
  throw new Error(`Failed after ${maxRetries} retries`);
}

// Function to map crypto symbols to CoinGecko IDs
async function mapCryptoIds() {
  console.log("Mapping crypto symbols to CoinGecko IDs...");
  
  // Get all active crypto assets
  const assets = db.prepare("SELECT DISTINCT asset FROM holdings WHERE asset_type = 'crypto' AND status = 'active'").all();
  
  // Get existing mappings
  const existingMappings = db.prepare("SELECT asset FROM token_mappings").all().map(row => row.asset);
  
  // Filter to only process assets that don't have mappings
  const unmappedAssets = assets.filter(asset => !existingMappings.includes(asset.asset));
  
  if (unmappedAssets.length === 0) {
    console.log("All assets are already mapped. Skipping mapping step.");
    return;
  }
  
  console.log(`Need to map ${unmappedAssets.length} assets`);
  
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
    'HYPE': 'hype',
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
    'KMNO': 'kemonos',
    'LFNTY': 'lifinity',
    'LDO': 'lido-dao',
    'MORPHO': 'morpho',
    'MOTO': 'motoverse',
    'PENGU': 'pengu',
    'PHNIX': 'phoenix-token',
    'PRIME': 'echelon-prime',
    'SCRAP': 'scrap',
    'TNSR': 'tensor',
    'XAI': 'xai',
    'XRP': 'ripple',
    'ZYN': 'zynergy'
    // Add more mappings as needed
  };
  
  // Process each asset
  for (const { asset } of unmappedAssets) {
    // Check if we need to respect rate limits
    await sleep(COINGECKO_RATE_LIMIT.requestDelay);
    
    try {
      // Check if we have a manual mapping
      if (manualMappings[asset]) {
        upsertMapping.run(
          asset,
          manualMappings[asset],
          asset.toLowerCase(),
          new Date().toISOString()
        );
        console.log(`Mapped ${asset} to ${manualMappings[asset]} (manual)`);
        continue;
      }
      
      // Otherwise, try to search for it, with rate limit handling
      try {
        const search = await makeApiCall(`${COINGECKO_API}/search`, { query: asset });
        
        if (search.data && search.data.coins && search.data.coins.length > 0) {
          // Take the first match as the most likely
          const coin = search.data.coins[0];
          upsertMapping.run(
            asset,
            coin.id,
            coin.symbol,
            new Date().toISOString()
          );
          console.log(`Mapped ${asset} to ${coin.id} (auto)`);
        } else {
          console.log(`No CoinGecko mapping found for ${asset}`);
        }
      } catch (error) {
        console.error(`Error searching for ${asset}:`, error.message);
      }
      
    } catch (error) {
      console.error(`Error mapping ${asset}:`, error.message);
    }
  }
}

// Function to fetch cryptocurrency prices
async function fetchCryptoPrices() {
  console.log("Fetching cryptocurrency prices...");
  
  // Get all mapped assets
  const mappedTokens = db.prepare("SELECT asset, coingecko_id FROM token_mappings").all();
  
  if (mappedTokens.length === 0) {
    console.log("No mapped crypto tokens found, run mapCryptoIds first");
    return;
  }
  
  console.log(`Found ${mappedTokens.length} tokens to fetch prices for`);
  
  // Process in smaller batches (10 per call) to be more conservative with rate limits
  const batchSize = 10;
  for (let i = 0; i < mappedTokens.length; i += batchSize) {
    // Respect rate limits between batches
    if (i > 0) {
      console.log(`Waiting for rate limit before processing next batch...`);
      await sleep(COINGECKO_RATE_LIMIT.requestDelay);
    }
    
    const batch = mappedTokens.slice(i, i + batchSize);
    const coinIds = batch.map(t => t.coingecko_id).join(',');
    
    console.log(`Processing batch ${i/batchSize + 1}/${Math.ceil(mappedTokens.length/batchSize)}: ${coinIds}`);
    
    try {
      const response = await makeApiCall(`${COINGECKO_API}/simple/price`, { 
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
          console.log(`Stored price for ${asset} (${coingecko_id}): $${price}`);
        } else {
          console.log(`Price not found for ${asset} (${coingecko_id})`);
        }
      });
      
      console.log(`Batch complete: ${foundCount}/${batch.length} prices found`);
      
    } catch (error) {
      console.error("Error fetching crypto prices:", error.message);
      if (error.response) {
        console.error("Response data:", error.response.data);
        console.error("Status:", error.response.status);
      }
    }
  }
}

// Function to fetch cryptocurrency prices using a fallback approach
// This alternative method gets one token at a time if the batch approach fails
async function fetchCryptoPricesFallback() {
  console.log("Using fallback method to fetch crypto prices one by one...");
  
  const mappedTokens = db.prepare("SELECT asset, coingecko_id FROM token_mappings").all();
  
  const insertPrice = db.prepare(
    "INSERT INTO prices (asset, price, date, source) VALUES (?, ?, ?, ?)"
  );
  
  for (const { asset, coingecko_id } of mappedTokens) {
    // Respect rate limits between requests
    await sleep(COINGECKO_RATE_LIMIT.requestDelay);
    
    try {
      console.log(`Fetching price for ${asset} (${coingecko_id})...`);
      const response = await makeApiCall(`${COINGECKO_API}/simple/price`, { 
        ids: coingecko_id, 
        vs_currencies: "usd"
      });
      
      const price = response.data[coingecko_id]?.usd || null;
      if (price !== null) {
        const now = new Date().toISOString();
        insertPrice.run(asset, price, now, 'coingecko');
        console.log(`Stored price for ${asset}: $${price}`);
      } else {
        console.log(`Price not found for ${asset}`);
      }
      
    } catch (error) {
      console.error(`Error fetching price for ${asset}:`, error.message);
    }
  }
}

// Function to fetch equity prices from Alpha Vantage
async function fetchStockPrices() {
  console.log("Fetching stock prices...");
  
  if (!ALPHA_VANTAGE_API_KEY || ALPHA_VANTAGE_API_KEY === "YOUR_API_KEY_HERE") {
    console.error("Alpha Vantage API key not found! Replace the placeholder in the script.");
    return;
  }
  
  const stocks = db.prepare("SELECT DISTINCT asset FROM holdings WHERE asset_type = 'equity' AND status = 'active'").all();
  
  if (stocks.length === 0) {
    console.log("No equity assets found");
    return;
  }
  
  const insertPrice = db.prepare(
    "INSERT INTO prices (asset, price, date, source) VALUES (?, ?, ?, ?)"
  );
  
  for (const { asset } of stocks) {
    try {
      console.log(`Fetching price for ${asset}...`);
      const response = await axios.get(ALPHA_VANTAGE_URL, {
        params: {
          function: "GLOBAL_QUOTE",
          symbol: asset,
          apikey: ALPHA_VANTAGE_API_KEY,
        },
      });
      
      const price = response.data["Global Quote"]?.["05. price"] || null;
      if (price !== null) {
        const now = new Date().toISOString();
        insertPrice.run(asset, parseFloat(price), now, 'alphavantage');
        console.log(`Stored stock price for ${asset}: $${price}`);
      } else {
        console.log(`Price not found for ${asset}`);
        if (response.data.Note) {
          console.log("API Note:", response.data.Note);
        }
      }
      
      // Alpha Vantage free tier limit: 5 requests per minute
      console.log("Waiting for Alpha Vantage rate limit...");
      await sleep(15000);
    } catch (error) {
      console.error(`Error fetching price for ${asset}:`, error.message);
      if (error.response) {
        console.error("Status:", error.response.status);
        console.error("Data:", error.response.data);
      }
      // Wait longer on error
      await sleep(30000);
    }
  }
}

// Function to run everything
async function main() {
  try {
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
      console.error("Batch approach failed, trying fallback method:", error.message);
      await fetchCryptoPricesFallback();
    }
    
    // Fetch stock prices
    await fetchStockPrices();
    
    // Print some statistics
    const stats = {
      totalPrices: db.prepare("SELECT COUNT(*) as count FROM prices").get().count,
      uniqueAssets: db.prepare("SELECT COUNT(DISTINCT asset) as count FROM prices").get().count,
      latestDate: db.prepare("SELECT MAX(date) as latest FROM prices").get().latest
    };
    
    console.log("\nPrice Database Statistics:");
    console.log(`Total Price Records: ${stats.totalPrices}`);
    console.log(`Unique Assets With Prices: ${stats.uniqueAssets}`);
    console.log(`Latest Price Date: ${stats.latestDate}`);
    
  } catch (error) {
    console.error("Error in main function:", error);
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
}

// Run the script
main();