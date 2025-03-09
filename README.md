# ResearchHoldings
Dashboard tracking top researcher's holdings.

Price data by [CoinGecko](https://www.coingecko.com/).

API KEYS (free)
Alpha Vantage : 5EKEPHEMLJHCWOUN


## Getting Started

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

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

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
│  │  │  └─ holdings
│  │  │     └─ route.ts
│  │  ├─ holdings
│  │  │  └─ page.tsx
│  │  └─ page.tsx
│  ├─ components
│  │  └─ HoldingsTable.tsx
│  └─ styles
│     ├─ globals.css
│     └─ table.module.css
└─ tsconfig.json

```