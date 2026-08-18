const cheerio = require("cheerio");

// Parsing the disclosures page, three independent ways.
//
// The page has already been rebuilt once under us: it was WordPress on
// blockworks.co, keyed off h2.wp-block-heading / figure.wp-block-table, and is now
// Next.js + Chakra on blockworks.com. That single-selector scraper returned zero
// rows for fourteen months without anyone noticing. So rather than one selector
// chain, every strategy below reads the page a different way and they are tried in
// order until one produces holdings:
//
//   dom       - headings paired with the tables that follow them (what a reader sees)
//   nextData  - the Sanity CMS payload in <script id="__NEXT_DATA__">, which survives
//               any amount of CSS or markup churn but disappears if they leave Next.js
//   loose     - any <table> at all, attributed to the nearest heading above it
//
// Column meanings come from the header row, never from a fixed index, because the
// schema changed too: Name|BTC|ETH|Altcoins|NFTs|Equities became
// Name|Tokens|NFTs|Crypto Equities.

// Cell values that mean "holds nothing in this category"
const EMPTY_CELL = new Set(["", "no", "none", "n/a", "na", "-", "—", "--", "*"]);

// A cell we'd accept as a list of assets rather than prose. Used only to decide
// whether an unrecognised column is worth ingesting.
const MAX_ASSET_NAME_LENGTH = 60;

function splitCell(text) {
  return String(text || "")
    .split(",")
    .map(value => value.replace(/\s+/g, " ").trim())
    .filter(value => !EMPTY_CELL.has(value.toLowerCase()));
}

// Map a column header to the kind of asset it holds.
function classifyHeader(header) {
  const label = String(header || "").toLowerCase().replace(/\s+/g, " ").trim();

  if (label === "name" || label === "member" || label === "team member" || label === "team member name") {
    return "name";
  }
  if (label === "tokens" || label === "token" || label === "altcoins" || label === "crypto" || label === "coins") {
    return "crypto";
  }
  if (label === "nfts" || label === "nft") return "nft";
  if (label.includes("equit") || label === "stocks" || label === "shares") return "equity";
  if (label.includes("angel")) return "angel";
  // Legacy layout carried one Yes/No column per major asset
  if (label === "btc" || label === "eth") return `yesno:${label.toUpperCase()}`;

  return null;
}

// Would this cell plausibly be a comma-separated list of tickers or project names?
// Guards the last-ditch path below from swallowing a "Notes" or "Comments" column.
function looksLikeAssetList(text) {
  const values = splitCell(text);
  if (values.length === 0) return false;
  return values.every(value => value.length <= MAX_ASSET_NAME_LENGTH && !/[.;:!?]/.test(value));
}

// Turn one table - given as a header row plus data rows of plain strings - into
// holdings. Every strategy funnels through here so the column rules exist once.
function rowsToHoldings(team, rows, report) {
  if (!rows || rows.length < 2) return [];

  const headerCells = rows[0];
  const columns = headerCells.map(classifyHeader);
  let nameIndex = columns.indexOf("name");

  // A renamed first column shouldn't cost us the whole table
  if (nameIndex === -1 && headerCells.length > 1) {
    nameIndex = 0;
    columns[0] = "name";
    report.warn(`"${team}": no recognised name column (headers: ${headerCells.join(" | ")}), assuming the first column`);
  }
  if (nameIndex === -1) return [];

  headerCells.forEach((header, i) => {
    if (columns[i] === null && header !== "") report.unknownHeader(`${team}: ${header}`);
  });

  const dataRows = rows.slice(1);
  const hasKnownAssetColumn = columns.some(kind => kind !== null && kind !== "name");

  // If every asset column was renamed out from under us, take the unrecognised
  // columns as untyped holdings rather than reporting the section as empty - but
  // only where the contents still read like a list of assets.
  if (!hasKnownAssetColumn) {
    const salvageable = headerCells.map((_, i) =>
      i !== nameIndex && dataRows.some(row => looksLikeAssetList(row[i]))
    );
    if (!salvageable.some(Boolean)) return [];
    salvageable.forEach((ok, i) => {
      if (ok) columns[i] = "other";
    });
    report.warn(`"${team}": no recognised asset columns, ingesting ${salvageable.filter(Boolean).length} as untyped`);
  }

  // A section that breaks holdings out by asset class is a real team. "Angel
  // Investments" is an asset category with its own table, and the people in it are
  // already listed under a team above - it must not reassign them.
  const isTeamSection = columns.some(kind =>
    kind === "crypto" || kind === "nft" || kind === "equity" || (kind !== null && kind.startsWith("yesno:"))
  );

  const holdings = [];

  dataRows.forEach(cells => {
    // Trailing footnote markers on names ("Jane Doe*") would fork one person into two
    const name = String(cells[nameIndex] || "").replace(/[*†‡]+$/, "").trim();
    if (!name) return;

    columns.forEach((kind, i) => {
      if (kind === null || kind === "name" || i >= cells.length) return;

      if (kind.startsWith("yesno:")) {
        if (String(cells[i]).trim().toLowerCase() === "yes") {
          holdings.push({ name, team, asset: kind.slice(6), assetType: "crypto", isTeamSection });
        }
        return;
      }

      splitCell(cells[i]).forEach(asset => {
        holdings.push({ name, team, asset, assetType: kind, isTeamSection });
      });
    });
  });

  return holdings;
}

const HEADINGS = "h1, h2, h3, h4, h5, h6";

// Read the tables out of the rendered DOM, attributing each to the heading above it.
//
// Table-first, not heading-first: pairing every heading with "the next table" lets a
// page-title <h1> and its section <h2> both claim the same table, which silently
// doubles those rows. One table, one heading.
//
// `deep` controls how hard we look. Off, the heading has to be a preceding sibling of
// the table or of one of its ancestors - the normal shape, and the shape the page has
// today. On, a heading nested inside a preceding sibling counts too, which recovers
// attribution when each heading gets sealed into its own wrapper.
function tablesWithHeadings($, { deep }) {
  return $("table").toArray().map(table => {
    let node = $(table);
    let team = "Unknown";

    outer: while (node.length && !node.is("body")) {
      for (const sibling of node.prevAll().toArray()) {
        const $sibling = $(sibling);
        const heading = $sibling.is(HEADINGS)
          ? $sibling
          : (deep ? $sibling.find(HEADINGS).last() : $());

        if (heading.length && heading.text().trim()) {
          team = heading.text().trim();
          break outer;
        }
      }
      node = node.parent();
    }

    const rows = $(table).find("tr").toArray().map(row =>
      $(row).find("th, td").toArray().map(cell => $(cell).text().trim())
    );

    return { team, rows };
  });
}

function collectTables($, report, options) {
  const holdings = [];

  tablesWithHeadings($, options).forEach(({ team, rows }) => {
    const parsed = rowsToHoldings(team, rows, report);
    if (parsed.length > 0) report.section(team, rows.length - 1, parsed.length);
    holdings.push(...parsed);
  });

  return holdings;
}

// Strategy 1: the rendered DOM, headings read as direct siblings.
function fromDom($, report) {
  return collectTables($, report, { deep: false });
}

// Recursively collect every string under `text` keys - portable text splits a cell
// across children whenever part of it is styled.
function flattenText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (typeof node === "object") {
    if (typeof node.text === "string" && !Array.isArray(node.children)) return node.text;
    const parts = [];
    if (Array.isArray(node.children)) parts.push(flattenText(node.children));
    else if (Array.isArray(node.content)) parts.push(flattenText(node.content));
    else if (typeof node.text === "string") parts.push(node.text);
    return parts.join("");
  }
  return "";
}

// Find the body array: the one list holding both heading blocks and table blocks.
function findBodyArray(node, depth = 0) {
  if (depth > 12 || node === null || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    if (node.some(item => item && typeof item === "object" && Array.isArray(item.rows))) return node;
    for (const item of node) {
      const found = findBodyArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(node)) {
    const found = findBodyArray(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// Strategy 2: the CMS payload behind the page. Immune to markup and CSS changes.
function fromNextData(html, report) {
  const match = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch (error) {
    report.warn(`__NEXT_DATA__ present but unparseable: ${error.message}`);
    return [];
  }

  const body = findBodyArray(payload);
  if (!body) return [];

  const holdings = [];
  let team = "Unknown";

  body.forEach(block => {
    if (!block || typeof block !== "object") return;

    if (typeof block.style === "string" && /^h[1-4]$/.test(block.style)) {
      const heading = flattenText(block).trim();
      if (heading) team = heading;
      return;
    }

    if (!Array.isArray(block.rows)) return;

    const rows = block.rows.map(row =>
      (row.cells || []).map(cell => flattenText(cell).trim())
    );

    const parsed = rowsToHoldings(team, rows, report);
    if (parsed.length > 0) report.section(team, rows.length - 1, parsed.length);
    holdings.push(...parsed);
  });

  return holdings;
}

// Strategy 3: last ditch. Same tables, but a heading wrapped inside a preceding
// sibling still counts - enough to keep attribution when the markup is rearranged.
function fromLooseTables($, report) {
  return collectTables($, report, { deep: true });
}

// The page states its own freshness ("August 2026 disclosures, updated July 31").
// Worth carrying through: it tells us the source is stale even when our scrape isn't.
function extractSourceNote(html) {
  const match = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const note = JSON.parse(match[1])?.props?.pageProps?.sanityPage?.lastUpdatedNote;
    return typeof note === "string" && note.trim() ? note.trim() : null;
  } catch {
    return null;
  }
}

// Two holdings lists are "the same" if they cover the same member/asset pairs.
function differenceSummary(a, b) {
  const key = h => `${h.name}::${h.asset}`;
  const setA = new Set(a.map(key));
  const setB = new Set(b.map(key));
  const onlyA = [...setA].filter(k => !setB.has(k));
  const onlyB = [...setB].filter(k => !setA.has(k));
  return { onlyA, onlyB };
}

/**
 * Parse the disclosures page.
 *
 * Returns { holdings, strategy, attempts, warnings, sourceNote }. `strategy` names
 * the reader that produced the holdings; anything other than "dom" means the page
 * moved and the primary reader needs attention even though data still came through.
 */
function parseDisclosures(html, { log = () => {} } = {}) {
  const warnings = [];
  const unknownHeaders = new Set();
  const sections = [];

  const report = {
    warn: message => warnings.push(message),
    unknownHeader: header => unknownHeaders.add(header),
    section: (team, memberCount, holdingCount) => sections.push({ team, memberCount, holdingCount }),
  };

  const $ = cheerio.load(html);

  const strategies = [
    { name: "dom", run: () => fromDom($, report) },
    { name: "nextData", run: () => fromNextData(html, report) },
    { name: "loose", run: () => fromLooseTables($, report) },
  ];

  const attempts = [];
  const results = [];

  for (const strategy of strategies) {
    const before = sections.length;
    let holdings = [];
    let error = null;

    try {
      holdings = strategy.run();
    } catch (e) {
      error = e.message;
      warnings.push(`strategy "${strategy.name}" threw: ${e.message}`);
    }

    // Rows we couldn't attribute to a team. A reader that finds the tables but not
    // the headings has technically "worked" while producing a dashboard where every
    // holding is filed under Unknown - it must not outrank one that got both.
    const unattributed = holdings.filter(h => h.team === "Unknown").length;

    attempts.push({ name: strategy.name, count: holdings.length, unattributed, error });
    results.push({ name: strategy.name, holdings, unattributed, sections: sections.slice(before) });
  }

  // First reader that got everything, else whichever saw the most.
  let winner = results.find(r => r.holdings.length > 0 && r.unattributed === 0);

  if (!winner) {
    const best = results.reduce((a, b) => (b.holdings.length > a.holdings.length ? b : a), results[0]);
    if (best.holdings.length > 0) {
      winner = best;
      warnings.push(
        `no reader could attribute every row to a team; using "${best.name}" with ${best.unattributed} of ${best.holdings.length} unattributed`
      );
    }
  }

  if (unknownHeaders.size > 0) {
    warnings.push(`unrecognised columns skipped: ${[...unknownHeaders].join(", ")}`);
  }

  if (!winner) {
    return { holdings: [], strategy: null, attempts, warnings, sections: [], sourceNote: extractSourceNote(html) };
  }

  if (winner.name !== "dom") {
    warnings.push(
      `primary DOM parser found nothing; fell back to "${winner.name}". The page layout has changed - data is still flowing but the selectors need updating.`
    );
  }

  // Cross-check: if a second reader also succeeded, they should broadly agree.
  const other = attempts.find(a => a.name !== winner.name && a.count > 0);
  if (other) {
    const ratio = Math.min(other.count, winner.holdings.length) / Math.max(other.count, winner.holdings.length);
    if (ratio < 0.9) {
      warnings.push(
        `readers disagree: "${winner.name}" found ${winner.holdings.length}, "${other.name}" found ${other.count}`
      );
    }
  }

  log(`parsed with "${winner.name}" strategy: ${winner.holdings.length} holdings`);
  winner.sections.forEach(s => log(`  ${s.team}: ${s.memberCount} members, ${s.holdingCount} holdings`));
  warnings.forEach(w => log(`  warning: ${w}`));

  return {
    holdings: winner.holdings,
    strategy: winner.name,
    attempts,
    warnings,
    sections: winner.sections,
    sourceNote: extractSourceNote(html),
  };
}

module.exports = {
  parseDisclosures,
  // exported for tests
  classifyHeader,
  splitCell,
  rowsToHoldings,
  differenceSummary,
};
