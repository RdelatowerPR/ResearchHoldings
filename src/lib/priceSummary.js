// The prices behind the Analytics view's figures (src/components/HoldingsAnalytics.tsx).
//
// The view only ever reads a few prices per asset, so /api/holdings/price-history sends
// those instead of every stored price (2.2 MB on 2026-10-21). One entry per asset named
// by an active holding - the view only gets active holdings - that has at least two
// prices (the view shows no change for an asset with fewer):
//
//   latest      the newest price.
//   monthAgo    the newest price from the day 30 days before `latest` or earlier, but no
//               more than 40 days before it. Null when there is none: the asset was first
//               priced less than 30 days ago, or its history has a gap there. The view
//               then shows N/A rather than a change over some other span.
//   sinceAdded  for each first_added date among the asset's active holdings, the first
//               price from that day on, or the oldest price when there is none.
//
// prices.date is a full ISO timestamp ("2026-09-21T03:06:07.812Z") and first_added is a
// day ("2026-09-21"), so days are compared as date(p.date). Comparing the timestamp itself
// with a day string would drop that day: "2026-09-21T03:06:07.812Z" > "2026-09-21".

const MONTH_DAYS = 30;
const MAX_MONTH_AGO_DAYS = 40;

function summarizePrices(db) {
  const assets = db.prepare(`
    SELECT asset
    FROM prices
    WHERE asset IN (SELECT asset FROM holdings WHERE status = 'active')
    GROUP BY asset
    HAVING COUNT(*) >= 2
    ORDER BY asset
  `).all();

  const latest = db.prepare(`
    SELECT p.date, p.price FROM prices p
    WHERE p.asset = ?
    ORDER BY p.date DESC, p.id DESC
    LIMIT 1
  `);

  const monthAgo = db.prepare(`
    SELECT p.price FROM prices p
    WHERE p.asset = ?
      AND date(p.date) <= date(?, '-${MONTH_DAYS} days')
      AND date(p.date) >= date(?, '-${MAX_MONTH_AGO_DAYS} days')
    ORDER BY p.date DESC, p.id DESC
    LIMIT 1
  `);

  const firstOnOrAfter = db.prepare(`
    SELECT p.price FROM prices p
    WHERE p.asset = ? AND date(p.date) >= ?
    ORDER BY p.date, p.id
    LIMIT 1
  `);

  const oldest = db.prepare(`
    SELECT p.price FROM prices p
    WHERE p.asset = ?
    ORDER BY p.date, p.id
    LIMIT 1
  `);

  const addedDates = db.prepare(`
    SELECT DISTINCT first_added FROM holdings
    WHERE status = 'active' AND asset = ?
    ORDER BY first_added
  `);

  return assets.map(({ asset }) => {
    const newest = latest.get(asset);
    const monthAgoRow = monthAgo.get(asset, newest.date, newest.date);
    const oldestPrice = oldest.get(asset).price;

    const sinceAdded = {};
    for (const { first_added } of addedDates.all(asset)) {
      const row = firstOnOrAfter.get(asset, first_added);
      sinceAdded[first_added] = row ? row.price : oldestPrice;
    }

    return {
      asset,
      latest: newest.price,
      monthAgo: monthAgoRow ? monthAgoRow.price : null,
      sinceAdded,
    };
  });
}

module.exports = { summarizePrices };
