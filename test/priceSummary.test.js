const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const { summarizePrices } = require("../src/lib/priceSummary");

// The two tables summarizePrices reads, as scripts/scrapeHoldings.js and
// scripts/fetchPrices.js create them.
function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER,
      asset TEXT,
      asset_type TEXT,
      first_added TEXT,
      status TEXT DEFAULT 'active',
      last_seen TEXT,
      UNIQUE(member_id, asset)
    );
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset TEXT NOT NULL,
      price REAL NOT NULL,
      date TEXT NOT NULL,
      source TEXT NOT NULL
    );
  `);
  return db;
}

let nextMember = 1;
function hold(db, asset, firstAdded, status = "active") {
  db.prepare("INSERT INTO holdings (member_id, asset, asset_type, first_added, status) VALUES (?, ?, 'crypto', ?, ?)")
    .run(nextMember++, asset, firstAdded, status);
}

function price(db, asset, date, value) {
  db.prepare("INSERT INTO prices (asset, price, date, source) VALUES (?, ?, ?, 'coingecko')").run(asset, value, date);
}

// One price a day at 03:00 UTC from `from` to `to`, worth 1000 plus the days since `from`
function daily(db, asset, from, to) {
  const end = new Date(`${to}T00:00:00Z`);
  for (let day = new Date(`${from}T00:00:00Z`), i = 0; day <= end; day.setUTCDate(day.getUTCDate() + 1), i++) {
    price(db, asset, `${day.toISOString().slice(0, 10)}T03:00:00.000Z`, 1000 + i);
  }
}

const summaryOf = (db, asset) => summarizePrices(db).find(s => s.asset === asset);

test("the month-ago price is the one from the day 30 days before the latest, whatever its time", () => {
  const db = freshDb();
  hold(db, "BTC", "2025-03-08");
  daily(db, "BTC", "2026-08-01", "2026-10-20");
  // Fetched later in the day than the latest price: neither a timestamp-to-day comparison
  // (the old query) nor "exactly 30 days before the latest" would pick it.
  db.prepare("UPDATE prices SET date = '2026-09-21T03:10:00.000Z', price = 81390 WHERE date LIKE '2026-09-21%'").run();
  price(db, "BTC", "2026-10-21T03:08:21.614Z", 82734);

  const btc = summaryOf(db, "BTC");
  assert.equal(btc.latest, 82734);
  assert.equal(btc.monthAgo, 81390);
  db.close();
});

test("with no price on that day, the month-ago price is the newest one before it", () => {
  const db = freshDb();
  hold(db, "COIN", "2025-03-08");
  daily(db, "COIN", "2026-09-01", "2026-10-21");
  db.prepare("DELETE FROM prices WHERE date LIKE '2026-09-21%'").run();

  assert.equal(summaryOf(db, "COIN").monthAgo, 1019, "the 2026-09-20 price");
  db.close();
});

test("an asset priced for less than 30 days has no month-ago price", () => {
  const db = freshDb();
  hold(db, "ZEC", "2026-09-30");
  hold(db, "SOL", "2026-09-21");
  daily(db, "ZEC", "2026-09-30", "2026-10-21");
  daily(db, "SOL", "2026-09-21", "2026-10-21");

  assert.equal(summaryOf(db, "ZEC").monthAgo, null);
  assert.equal(summaryOf(db, "SOL").monthAgo, 1000, "exactly 30 days is enough");
  db.close();
});

test("the month-ago price is at most 40 days old, so a gap in the history gives none", () => {
  const db = freshDb();
  hold(db, "ETHE", "2025-03-08");
  daily(db, "ETHE", "2025-03-08", "2025-05-02");
  daily(db, "ETHE", "2026-09-30", "2026-10-21");
  hold(db, "FBTC", "2025-03-08");
  price(db, "FBTC", "2026-09-10T03:00:00.000Z", 50);
  price(db, "FBTC", "2026-09-11T03:00:00.000Z", 60);
  price(db, "FBTC", "2026-10-21T03:00:00.000Z", 70);

  assert.equal(summaryOf(db, "ETHE").monthAgo, null, "not the 2025-05-02 price");
  assert.equal(summaryOf(db, "FBTC").monthAgo, 60, "40 days back is still used");
  db.close();
});

test("the since-added price is the first one from the first_added day on", () => {
  const db = freshDb();
  hold(db, "HYPE", "2025-03-08");
  hold(db, "HYPE", "2026-08-17");
  hold(db, "HYPE", "2026-10-25");
  price(db, "HYPE", "2026-08-16T23:00:00.000Z", 0.050472);
  price(db, "HYPE", "2026-08-17T01:00:00.000Z", 0.050473);
  price(db, "HYPE", "2026-08-17T21:20:00.000Z", 58.71);
  price(db, "HYPE", "2026-10-21T03:08:00.000Z", 40);

  assert.deepEqual(summaryOf(db, "HYPE").sinceAdded, {
    "2025-03-08": 0.050472, // before every price: the first one
    "2026-08-17": 0.050473, // a price at 01:00 UTC is that day's
    "2026-10-25": 0.050472, // after every price: the oldest one
  });
  db.close();
});

test("only priced assets of active holdings are listed, with their active first_added dates", () => {
  const db = freshDb();
  hold(db, "SOL", "2026-10-05");
  hold(db, "SOL", "2026-10-10");
  hold(db, "SOL", "2026-10-01", "inactive");
  hold(db, "OLD", "2026-10-01", "inactive");
  hold(db, "ONE", "2026-10-01");
  hold(db, "NFT", "2026-10-01");
  daily(db, "SOL", "2026-09-25", "2026-10-21");
  daily(db, "OLD", "2026-09-25", "2026-10-21");
  price(db, "ONE", "2026-10-21T03:00:00.000Z", 5);

  const summary = summarizePrices(db);
  assert.deepEqual(summary.map(s => s.asset), ["SOL"], "no inactive-only, single-price or unpriced asset");
  assert.deepEqual(summary[0].sinceAdded, { "2026-10-05": 1010, "2026-10-10": 1015 });
  db.close();
});
