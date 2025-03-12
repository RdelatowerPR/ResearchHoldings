# ResearchHoldings
Dashboard tracking Blockworks Research holdings. Feel free to download or modify the repo.

Price data by [CoinGecko](https://www.coingecko.com/).
Equity data by AlphaVantage.

Holdings by Blockworks [Financial Disclosures](https://blockworks.co/financial-disclosures).


## Description
Visit https://research-holdings.vercel.app/ for the live dashboard.

There are two views:
Table View: Contains all entries in the database (price data refreshed daily). 
Analytics View: Contains insights on employee holdings and their performance.

## Getting Started
If you would like to download and run this locally follow these steps.

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

How it should look in your directory (if you want to run it locally)
```
blockworks-dashboard
├─ data
│  └─ holdings.db
├─ eslint.config.mjs
├─ next.config.ts
├─ package-lock.json
├─ package.json
├─ public
│  ├─ file.svg
│  ├─ globe.svg
│  ├─ next.svg
│  ├─ vercel.svg
│  └─ window.svg
├─ README.md
├─ scripts
│  ├─ fetchPrices.js
│  └─ scrapeHoldings.js
├─ src
│  ├─ app
│  │  ├─ api
│  │  │  ├─ holdings
│  │  │  │  ├─ price-history
│  │  │  │  │  └─ route.ts
│  │  │  │  └─ route.ts
│  │  │  └─ last-updated
│  │  │     └─ route.ts
│  │  ├─ holdings
│  │  │  └─ page.tsx
│  │  ├─ layout.tsx
│  │  └─ page.tsx
│  ├─ components
│  │  ├─ HoldingsAnalytics.tsx
│  │  ├─ HoldingsTable.tsx
│  │  └─ LastUpdated.tsx
│  └─ styles
│     ├─ analytics.module.css
│     ├─ globals.css
│     ├─ home.module.css
│     └─ table.module.css
└─ tsconfig.json

```
