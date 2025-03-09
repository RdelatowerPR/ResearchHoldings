import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";

// Define types for our database results
type Holding = {
  name: string;
  team: string;
  asset: string;
  asset_type: string;
  first_added: string;
  status: string;
  last_seen: string;
  current_price?: number;
  price_date?: string;
  latest_price_date?: string;
};

// Connect to SQLite Database
const dbPath = path.resolve(process.cwd(), "data/holdings.db");

export async function GET(request: Request) {
  let db;
  
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'active';
    const statusFilter = status === 'all' ? '' : `WHERE h.status = '${status}'`;
    
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
          h.last_seen,
          (SELECT p.price FROM prices p 
           WHERE p.asset = h.asset 
           ORDER BY p.date DESC LIMIT 1) as current_price,
          (SELECT p.date FROM prices p 
           WHERE p.asset = h.asset 
           ORDER BY p.date DESC LIMIT 1) as price_date,
          (SELECT MAX(date) FROM prices WHERE asset = h.asset) as latest_price_date
        FROM holdings h
        JOIN members m ON h.member_id = m.id
        ${statusFilter !== '' ? statusFilter : ''}
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
          h.status,
          h.last_seen
        FROM holdings h
        JOIN members m ON h.member_id = m.id
        ${statusFilter !== '' ? statusFilter : ''}
        ORDER BY m.name, h.asset
      `);
    }
    
    const holdings = holdingsQuery.all() as Holding[];
    
    // Get unique teams without using spread operator on Set
    const teamsSet = new Set<string>();
    holdings.forEach(h => teamsSet.add(h.team));
    const uniqueTeams = Array.from(teamsSet);
    
    // Get summary statistics
    const stats = {
      totalHoldings: holdings.length,
      activeHoldings: holdings.filter(h => h.status === 'active').length,
      inactiveHoldings: holdings.filter(h => h.status === 'inactive').length,
      uniqueAssets: new Set(holdings.map(h => h.asset)).size,
      uniqueMembers: new Set(holdings.map(h => h.name)).size,
      teams: uniqueTeams.map(team => {
        const teamHoldings = holdings.filter(h => h.team === team);
        return {
          name: team,
          members: new Set(teamHoldings.map(h => h.name)).size,
          assets: new Set(teamHoldings.map(h => h.asset)).size,
          activeAssets: new Set(teamHoldings.filter(h => h.status === 'active').map(h => h.asset)).size
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