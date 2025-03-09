import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";

// Connect to SQLite Database
const dbPath = path.resolve(process.cwd(), "data/holdings.db");

type Asset = {
  asset: string;
};

type Price = {
  date: string;
  price: number;
};

type MonthlyChange = {
  asset: string;
  current_price: number;
  month_ago_price: number;
  monthly_change: number;
};

export async function GET() {
  let db;
  
  try {
    db = new Database(dbPath, { readonly: true });
    
    // Check if the prices table exists
    const hasPricesTable = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='prices'
    `).get();
    
    if (!hasPricesTable) {
      return NextResponse.json({
        message: "No price data available",
        priceHistories: []
      });
    }
    
    // Get all distinct assets with price data
    const assets = db.prepare(`
      SELECT DISTINCT asset FROM prices
    `).all() as Asset[];
    
    const priceHistories = [];
    
    // For each asset, get its price history
    for (const { asset } of assets) {
      const prices = db.prepare(`
        SELECT date, price 
        FROM prices 
        WHERE asset = ? 
        ORDER BY date DESC
      `).all(asset) as Price[];
      
      if (prices.length > 0) {
        priceHistories.push({
          asset,
          prices
        });
      }
    }
    
    // Get monthly change for each asset
    const monthlyChanges = db.prepare(`
      WITH current_prices AS (
        SELECT asset, price, date,
               ROW_NUMBER() OVER (PARTITION BY asset ORDER BY date DESC) as rn
        FROM prices
      ),
      month_ago_prices AS (
        SELECT p1.asset, p1.price as current_price, p2.price as month_ago_price
        FROM current_prices p1
        LEFT JOIN prices p2 ON p1.asset = p2.asset
        WHERE p1.rn = 1
        AND p2.date <= date(p1.date, '-30 days')
        AND p2.date >= date(p1.date, '-40 days')
      )
      SELECT asset, 
             current_price, 
             month_ago_price,
             (current_price - month_ago_price) / month_ago_price * 100 as monthly_change
      FROM month_ago_prices
      WHERE month_ago_price IS NOT NULL
    `).all() as MonthlyChange[];
    
    return NextResponse.json({
      priceHistories,
      monthlyChanges
    });
  } catch (error) {
    console.error("Error fetching price history:", error);
    return NextResponse.json(
      { error: "Failed to fetch price history" },
      { status: 500 }
    );
  } finally {
    if (db) db.close();
  }
}