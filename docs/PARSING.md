# How the disclosures page is read

`scripts/lib/parseDisclosures.js` is the part that broke last time, so it is written
to survive the page changing shape rather than to match one specific layout.

## Three readers, tried in order

Each reads the page a different way. The first one that produces a complete result
wins; the others still run, and their counts are recorded so disagreement is visible.

| Reader | How it works | Survives | Dies if |
| --- | --- | --- | --- |
| `dom` | every `<table>`, attributed to the heading that precedes it or one of its ancestors | CSS/class churn, tag renames, wrapper divs | headings stop preceding their tables |
| `nextData` | the Sanity CMS payload inside `<script id="__NEXT_DATA__">` | *any* markup or styling change | Blockworks leaves Next.js |
| `loose` | same as `dom`, but a heading nested inside a preceding sibling also counts | headings being wrapped in `<header>`/`<div>` | there are no `<table>` elements |

The two main readers are deliberately unrelated: `dom` reads what a visitor sees,
`nextData` reads the CMS record behind it. A change that breaks one usually leaves the
other working. On the current page all three agree at 182 holdings, and the run record
logs `dom=182,nextData=182,loose=182`.

**Falling back is a warning, not a success.** If anything other than `dom` wins, the
run still writes its data, but logs that the layout changed and the primary reader
needs fixing — in the log, in `metadata.json`, and in `data/run-history.jsonl`.

## Table-first, not heading-first

Pairing each heading with "the next table" looks natural and is wrong: a page-title
`<h1>` and a section `<h2>` will both claim the same table, silently doubling those
rows. The tests caught exactly this — 202 holdings where there were 182. Reading
tables and looking *backwards* for a heading makes the pairing one-to-one.

## Columns are read by name

The schema has already changed once:

```
old   Name | BTC | ETH | Altcoins | NFTs | Equities        (Yes/No per major asset)
new   Name | Tokens | NFTs | Crypto Equities
```

`classifyHeader()` maps a header string to `name`, `crypto`, `nft`, `equity`, `angel`,
or a legacy `yesno:BTC` column. Fixed column indexes would have mislabelled every
asset on the day that changed. Both layouts parse today.

Degradations, in order of severity:

- **Unknown column** → skipped, listed in the warnings.
- **No recognisable name column** → the first column is assumed, with a warning.
- **No recognisable asset columns at all** → columns whose cells still *look* like
  comma-separated assets are ingested as `other`; prose columns are left alone. Data
  keeps flowing under a new schema instead of the section reading as empty.

## Angel Investments is not a team

`members.name` is unique and carries one team. The Angel Investments table repeats
people already listed under a real team, so a naive upsert moves Jason Yanowitz and
Michael Ippolito out of Blockworks Media. Only sections that break holdings out by
asset class set a member's team; the rest fill in unknown members without overwriting
known ones.

## The guard

`assertScrapeIsSane()` in `scripts/scrapeHoldings.js` refuses to write when the parse
returns nothing, or less than half of what is currently active. This is the safeguard
that would have turned the fourteen-month outage into a failed job on day one.

## Fixtures

`test/fixtures/` holds real and synthetic page shapes. Add one whenever the page
changes — that is what stops the same break happening twice.

| Fixture | Represents |
| --- | --- |
| `current-page.html` | the live page, styles and non-payload scripts stripped |
| `dom-only.html` | live page with the CMS payload removed |
| `next-data-only.html` | live page with every table removed from the DOM |
| `legacy-wordpress.html` | the pre-2025 blockworks.co layout, Yes/No columns |
| `detached-headings.html` | headings sealed in wrappers, away from their tables |
| `renamed-columns.html` | unrecognised asset columns plus a prose column |
| `no-tables.html` | a 200 response with nothing to parse |
