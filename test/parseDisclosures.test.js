const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  parseDisclosures,
  classifyHeader,
  splitCell,
  rowsToHoldings,
} = require("../scripts/lib/parseDisclosures");
const { rejectionReason } = require("../scripts/lib/fetchPage");

const fixture = name => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const assetsFor = (holdings, name) =>
  holdings.filter(h => h.name === name).map(h => `${h.asset}:${h.assetType}`).sort();

const silentReport = () => ({ warn() {}, unknownHeader() {}, section() {} });

// --- the page as it stands today -------------------------------------------------

test("current page parses with the primary DOM reader", () => {
  const result = parseDisclosures(fixture("current-page.html"));

  assert.equal(result.strategy, "dom");
  assert.ok(result.holdings.length > 150, `expected >150 holdings, got ${result.holdings.length}`);

  const teams = [...new Set(result.holdings.map(h => h.team))];
  assert.deepEqual(teams.sort(), [
    "Angel Investments",
    "Blockworks Advisory",
    "Blockworks Data",
    "Blockworks Media",
    "Blockworks Research",
  ]);
});

test("current page: a member's row maps to the right asset types", () => {
  const { holdings } = parseDisclosures(fixture("current-page.html"));

  assert.deepEqual(assetsFor(holdings, "Kunal Doshi"), [
    "BTC:crypto",
    "HOOD:equity",
    "HYPE:crypto",
    "PUMP:crypto",
    "PUMPCADE:crypto",
    "Pudgy Penguins:nft",
  ]);
});

test("current page: 'No' rows contribute nothing", () => {
  const { holdings } = parseDisclosures(fixture("current-page.html"));
  assert.equal(holdings.filter(h => h.name === "Cristian Soto").length, 0);
  assert.equal(holdings.filter(h => /^(No|no|-)$/.test(h.asset)).length, 0);
});

test("the Angel Investments table is not treated as a team", () => {
  const { holdings } = parseDisclosures(fixture("current-page.html"));

  const angel = holdings.filter(h => h.assetType === "angel");
  assert.ok(angel.length > 40, `expected the angel list to be sizeable, got ${angel.length}`);
  // Every angel row must decline to set its member's team, or Jason Yanowitz and
  // Michael Ippolito get moved out of Blockworks Media.
  assert.ok(angel.every(h => h.isTeamSection === false));

  const research = holdings.filter(h => h.team === "Blockworks Research");
  assert.ok(research.every(h => h.isTeamSection === true));
});

test("the page's own freshness note is carried through", () => {
  const { sourceNote } = parseDisclosures(fixture("current-page.html"));
  assert.match(sourceNote, /disclosures/i);
});

// --- resilience: each reader can carry the page alone ----------------------------

test("with the CMS payload stripped, the DOM reader still carries it", () => {
  const result = parseDisclosures(fixture("dom-only.html"));
  assert.equal(result.strategy, "dom");
  assert.ok(result.holdings.length > 150);
});

test("with every table torn out of the DOM, the CMS payload carries it", () => {
  const result = parseDisclosures(fixture("next-data-only.html"));

  assert.equal(result.strategy, "nextData");
  assert.ok(result.holdings.length > 150);
  assert.ok(
    result.warnings.some(w => w.includes("layout has changed")),
    "falling back should warn that the primary reader is broken"
  );
});

test("the two readers agree on the live page", () => {
  const result = parseDisclosures(fixture("current-page.html"));
  const dom = result.attempts.find(a => a.name === "dom").count;
  const next = result.attempts.find(a => a.name === "nextData").count;

  assert.equal(dom, next, "DOM and CMS payload should see the same holdings");
  assert.ok(!result.warnings.some(w => w.includes("readers disagree")));
});

test("headings detached from their tables fall through to the last-ditch reader", () => {
  const result = parseDisclosures(fixture("detached-headings.html"));

  assert.equal(result.strategy, "loose");
  assert.deepEqual(assetsFor(result.holdings, "Jane Doe"), ["BTC:crypto", "HOOD:equity", "HYPE:crypto"]);
  assert.equal(result.holdings.find(h => h.name === "Sam Adviser").team, "Blockworks Advisory");
});

test("the legacy WordPress layout still parses, Yes/No columns included", () => {
  const result = parseDisclosures(fixture("legacy-wordpress.html"));

  assert.equal(result.strategy, "dom");
  assert.deepEqual(assetsFor(result.holdings, "Jane Doe"), [
    "BTC:crypto",
    "COIN:equity",
    "SOL:crypto",
    "TIA:crypto",
  ]);
  assert.deepEqual(assetsFor(result.holdings, "John Roe"), [
    "BTC:crypto",
    "ETH:crypto",
    "Pudgy Penguins:nft",
  ]);
  assert.equal(assetsFor(result.holdings, "Nobody Holding").length, 0);
});

test("renamed asset columns still yield data, and prose columns are left alone", () => {
  const result = parseDisclosures(fixture("renamed-columns.html"));

  assert.deepEqual(assetsFor(result.holdings, "Jane Doe"), ["BTC:other", "HYPE:other"]);
  // The Commentary column is sentences, not a list of assets
  assert.ok(!result.holdings.some(h => h.asset.includes("compliance")));
  assert.ok(result.warnings.some(w => w.includes("untyped")));
});

// --- the failure that started all this -------------------------------------------

test("a page with no tables yields nothing rather than something wrong", () => {
  const result = parseDisclosures(fixture("no-tables.html"));

  assert.equal(result.holdings.length, 0);
  assert.equal(result.strategy, null);
  assert.deepEqual(result.attempts.map(a => a.count), [0, 0, 0]);
});

test("the old selectors against the new page is the exact 14-month outage", () => {
  // h2.wp-block-heading matched nothing on the rebuilt page, and the scraper wrote
  // that empty result straight through. Proving the shape of the bug keeps the
  // regression honest: what changed is that we now return 0 and refuse to write.
  const cheerio = require("cheerio");
  const $ = cheerio.load(fixture("current-page.html"));

  assert.equal($("h2.wp-block-heading").length, 0);
  assert.equal($("figure.wp-block-table").length, 0);
  assert.ok($("h2").length >= 5, "the headings are still there, just not those classes");
});

// --- unit level ------------------------------------------------------------------

test("classifyHeader maps current, legacy and unknown headers", () => {
  assert.equal(classifyHeader("Name"), "name");
  assert.equal(classifyHeader("  TEAM MEMBER "), "name");
  assert.equal(classifyHeader("Tokens"), "crypto");
  assert.equal(classifyHeader("Altcoins"), "crypto");
  assert.equal(classifyHeader("NFTs"), "nft");
  assert.equal(classifyHeader("Crypto Equities"), "equity");
  assert.equal(classifyHeader("Equities"), "equity");
  assert.equal(classifyHeader("Angel Investments"), "angel");
  assert.equal(classifyHeader("BTC"), "yesno:BTC");
  assert.equal(classifyHeader("Notes"), null);
  assert.equal(classifyHeader(undefined), null);
});

test("splitCell drops the empty placeholders", () => {
  assert.deepEqual(splitCell("BTC, ETH ,SOL"), ["BTC", "ETH", "SOL"]);
  assert.deepEqual(splitCell("No"), []);
  assert.deepEqual(splitCell("-"), []);
  assert.deepEqual(splitCell(""), []);
  assert.deepEqual(splitCell(null), []);
  assert.deepEqual(splitCell("BTC,, ETH"), ["BTC", "ETH"]);
});

test("a renamed name column is assumed rather than dropped", () => {
  const rows = [
    ["Analyst", "Tokens"],
    ["Jane Doe", "BTC"],
  ];
  const holdings = rowsToHoldings("Research", rows, silentReport());
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].name, "Jane Doe");
});

test("footnote markers don't fork one person into two", () => {
  const rows = [
    ["Name", "Tokens"],
    ["Jane Doe*", "BTC"],
    ["Jane Doe", "ETH"],
  ];
  const holdings = rowsToHoldings("Research", rows, silentReport());
  assert.deepEqual([...new Set(holdings.map(h => h.name))], ["Jane Doe"]);
});

test("a header-only table produces nothing", () => {
  assert.deepEqual(rowsToHoldings("Research", [["Name", "Tokens"]], silentReport()), []);
  assert.deepEqual(rowsToHoldings("Research", [], silentReport()), []);
});

// --- fetch validation ------------------------------------------------------------

test("rejectionReason refuses pages that are not the disclosures page", () => {
  const good = "<html><body>" + "x".repeat(3000) + " financial disclosure table</body></html>";

  assert.equal(rejectionReason(good), null);
  assert.match(rejectionReason("<html>too short</html>"), /only \d+ bytes/);
  assert.match(rejectionReason(null), /not HTML/);
  assert.match(
    rejectionReason("<html><title>Just a moment...</title>" + "x".repeat(3000) + "disclosure</html>"),
    /bot challenge/
  );
  assert.match(
    rejectionReason("<html><title>404 Not Found</title>" + "x".repeat(3000) + "disclosure</html>"),
    /404/
  );
  assert.match(rejectionReason("<html>" + "x".repeat(3000) + "</html>"), /never mentions disclosures/);
});
