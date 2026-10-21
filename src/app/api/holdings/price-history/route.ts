import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import { summarizePrices } from "../../../../lib/priceSummary";

// Connect to SQLite Database
const dbPath = path.resolve(process.cwd(), "data/holdings.db");

// The prices the Analytics view needs per asset (see src/lib/priceSummary.js), not every
// stored price.
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
        assets: []
      });
    }
    
    return NextResponse.json({
      assets: summarizePrices(db)
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