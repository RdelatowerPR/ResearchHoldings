const axios = require("axios");
const cheerio = require("cheerio");
const Database = require("better-sqlite3");

// URL of Blockworks Financial Disclosures
const BLOCKWORKS_URL = "https://blockworks.co/financial-disclosures";

// Initialize SQLite database
const db = new Database("data/holdings.db");

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
    console.log("Migrating database to add new schema...");
    
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
    
    console.log("Migration completed successfully.");
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

// Function to scrape data
async function scrapeBlockworksData() {
  console.log("Fetching Blockworks financial disclosures...");
  const { data } = await axios.get(BLOCKWORKS_URL);
  const $ = cheerio.load(data);

  let holdings = [];

  // Find all team sections
  $("h2.wp-block-heading").each((_, heading) => {
    const team = $(heading).text().trim();
    console.log(`Switched to team: ${team}`);

    // Locate the figure element that contains the table
    const nextFigure = $(heading).next("figure.wp-block-table");
    if (nextFigure.length === 0) {
      console.log(`No holdings table found for ${team}, skipping...`);
      return;
    }

    const table = nextFigure.find("table");
    if (table.length === 0) {
      console.log(`No table inside figure for ${team}, skipping...`);
      return;
    }

    console.log(`Found table for ${team}! Extracting holdings...`);

    // Parse table rows
    table.find("tbody tr").each((_, row) => {
      const columns = $(row).find("td");
      if (columns.length > 1) {
        const name = $(columns[0]).text().trim();
        const btc = $(columns[1]).text().trim() === "Yes" ? "BTC" : null;
        const eth = $(columns[2]).text().trim() === "Yes" ? "ETH" : null;
        const altcoins = $(columns[3]).text().trim().split(",").map(a => a.trim()).filter(a => a !== "");
        const nfts = $(columns[4]).text().trim().split(",").map(a => a.trim()).filter(a => a !== "");
        const equities = $(columns[5]).text().trim().split(",").map(a => a.trim()).filter(a => a !== "");

        const assets = [btc, eth, ...altcoins, ...nfts, ...equities]
          .filter(a => a !== null) // Filter out null values before trimming
          .map(a => a.trim())
          .filter(a => a !== "" && a !== "No"); // Ignore empty and "No" entries
        
        console.log(`Extracted: Name=${name}, Team=${team}, Assets=${assets.join(', ')}`);

        assets.forEach((asset) => {
          // Determine asset type
          let assetType = "other";
          if (asset === "BTC" || asset === "ETH" || altcoins.includes(asset)) {
            assetType = "crypto";
          } else if (nfts.includes(asset)) {
            assetType = "nft";
          } else if (equities.includes(asset)) {
            assetType = "equity";
          }
          
          holdings.push({ 
            name, 
            team, 
            asset: asset.trim(),
            assetType
          });
        });
      }
    });
  });

  console.log(`Extracted ${holdings.length} holdings in total`);
  return holdings;
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
      "INSERT INTO current_holdings (member_id, asset) VALUES (?, ?)"
    );

    // Get member id
    const getMemberId = db.prepare("SELECT id FROM members WHERE name = ?");

    // Count how many new entries were added
    let newEntries = 0;
    let updatedEntries = 0;
    
    console.log(`Processing ${holdings.length} holdings...`);
    
    holdings.forEach(({ name, team, asset, assetType }) => {
      if (!asset || !asset.trim()) return; // Skip empty assets
      
      // Upsert the member
      upsertMember.run(name, team);
      
      // Get the member id
      const member = getMemberId.get(name);
      
      if (!member) {
        console.error(`Skipping asset ${asset} for ${name}, member not found.`);
        return;
      }

      // Check if this holding already exists
      const existingHolding = db.prepare(
        "SELECT id FROM holdings WHERE member_id = ? AND asset = ?"
      ).get(member.id, asset);

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
    console.log(`Database updated: ${newEntries} new holdings added, ${updatedEntries} existing holdings updated.`);
    console.log(`${inactiveResult.changes} holdings marked as inactive (sold/removed).`);
  
  } catch (error) {
    // Rollback on error
    db.exec('ROLLBACK');
    console.error('Error updating database:', error);
    throw error;
  }
}

// Run the scraper
(async () => {
  try {
    initializeDatabase();
    const holdings = await scrapeBlockworksData();
    saveToDatabase(holdings);
    
    // Optional: Print statistics about the database
    const stats = {
      totalHoldings: db.prepare("SELECT COUNT(*) as count FROM holdings").get().count,
      activeHoldings: db.prepare("SELECT COUNT(*) as count FROM holdings WHERE status = 'active'").get().count,
      inactiveHoldings: db.prepare("SELECT COUNT(*) as count FROM holdings WHERE status = 'inactive'").get().count,
      totalMembers: db.prepare("SELECT COUNT(*) as count FROM members").get().count
    };
    
    console.log("\nDatabase Statistics:");
    console.log(`Total Members: ${stats.totalMembers}`);
    console.log(`Total Holdings (all-time): ${stats.totalHoldings}`);
    console.log(`Currently Active Holdings: ${stats.activeHoldings}`);
    console.log(`Inactive Holdings (sold/removed): ${stats.inactiveHoldings}`);
    
  } catch (error) {
    console.error('Error running scraper:', error);
  } finally {
    db.close();
  }
})();