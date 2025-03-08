const axios = require("axios");
const cheerio = require("cheerio");
const Database = require("better-sqlite3");

// URL of Blockworks Financial Disclosures
const BLOCKWORKS_URL = "https://blockworks.co/financial-disclosures";

// Initialize SQLite database
const db = new Database("data/holdings.db");

// Function to create tables if they don’t exist
function initializeDatabase() {
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
      FOREIGN KEY (member_id) REFERENCES members(id)
    );
  `);
}

// Function to scrape data
async function scrapeBlockworksData() {
  console.log("Fetching Blockworks financial disclosures...");
  const { data } = await axios.get(BLOCKWORKS_URL);
  const $ = cheerio.load(data);

  let team = "";
  let holdings = [];

  console.log("Checking HTML Structure...");
  
  // Log all headings and tables found
  $("h2, h3, table").each((index, element) => {
    const tag = $(element).prop("tagName").toLowerCase();
    console.log(`Found ${tag}:`, $(element).text().trim().slice(0, 50)); // Log first 50 chars
  });

  $("h2, h3, table").each((_, element) => {
    const tag = $(element).prop("tagName").toLowerCase();

    if (tag === "h2" || tag === "h3") {
      team = $(element).text().trim();
      console.log(`Switched to team: ${team}`);
    } else if (tag === "table") {
      $(element)
        .find("tbody tr")
        .each((_, row) => {
          const columns = $(row).find("td");
          if (columns.length > 1) {
            const name = $(columns[0]).text().trim();
            const assets = $(columns[1]).text().trim().split(",");

            console.log(`Extracted: Name=${name}, Team=${team}, Assets=${assets}`);

            assets.forEach((asset) => {
              holdings.push({ name, team, asset: asset.trim() });
            });
          }
        });
    }
  });

  console.log("Final holdings:", holdings);
  return holdings;
}


// Function to save scraped data into SQLite
function saveToDatabase(holdings) {
  const insertMember = db.prepare(
    "INSERT OR IGNORE INTO members (name, team) VALUES (?, ?)"
  );
  const insertHolding = db.prepare(
    "INSERT INTO holdings (member_id, asset, asset_type, first_added) VALUES (?, ?, ?, DATE('now'))"
  );

  console.log(`Saving ${holdings.length} holdings to database...`);
  holdings.forEach(({ name, team, asset }) => {
    insertMember.run(name, team);
    const member = db.prepare("SELECT id FROM members WHERE name = ?").get(name);
    insertHolding.run(member.id, asset, "crypto", new Date().toISOString());
  });

  console.log("Database updated successfully.");
}

// Run the scraper
(async () => {
  initializeDatabase();
  const holdings = await scrapeBlockworksData();
  saveToDatabase(holdings);
  db.close();
})();
