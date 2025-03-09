import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";

// Connect to SQLite Database
const dbPath = path.resolve(process.cwd(), "data/holdings.db");

export async function GET() {
  let db;
  
  try {
    db = new Database(dbPath, { readonly: true });
    
    // Check if the prices table exists
    const hasPricesTable = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='prices'
    `).get();
    
    let holdingsQuery;
    
    if (hasPricesTable) {
      // Get the latest price for each asset
      holdingsQuery = db.prepare(`
        SELECT 
          m.name, 
          m.team, 
          h.asset, 
          h.asset_type, 
          h.first_added, 
          h.status,
          (SELECT p.price FROM prices p 
           WHERE p.asset = h.asset 
           ORDER BY p.date DESC LIMIT 1) as current_price,
          (SELECT p.date FROM prices p 
           WHERE p.asset = h.asset 
           ORDER BY p.date DESC LIMIT 1) as price_date
        FROM holdings h
        JOIN members m ON h.member_id = m.id
        WHERE h.status = 'active'
        ORDER BY m.name, h.asset
      `);
    } else {
      // If prices table doesn't exist, just get holdings
      holdingsQuery = db.prepare(`
        SELECT 
          m.name, 
          m.team, 
          h.asset, 
          h.asset_type, 
          h.first_added, 
          h.status
        FROM holdings h
        JOIN members m ON h.member_id = m.id
        WHERE h.status = 'active'
        ORDER BY m.name, h.asset
      `);
    }
    
    const holdings = holdingsQuery.all();
    
    // Get summary statistics
    const stats = {
      totalHoldings: holdings.length,
      uniqueAssets: new Set(holdings.map(h => h.asset)).size,
      uniqueMembers: new Set(holdings.map(h => h.name)).size,
      teams: [...new Set(holdings.map(h => h.team))].map(team => {
        const teamHoldings = holdings.filter(h => h.team === team);
        return {
          name: team,
          members: new Set(teamHoldings.map(h => h.name)).size,
          assets: new Set(teamHoldings.map(h => h.asset)).size
        };
      })
    };
    
    return NextResponse.json({
      holdings,
      stats
    });
  } catch (error) {
    console.error("Error fetching holdings:", error);
    return NextResponse.json(
      { error: "Failed to fetch holdings data" },
      { status: 500 }
    );
  } finally {
    if (db) db.close();
  }
}

