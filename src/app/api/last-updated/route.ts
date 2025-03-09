// app/api/last-updated/route.ts
import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

export async function GET() {
  try {
    // Get the modification time of the database file
    const dbPath = path.resolve(process.cwd(), 'data/holdings.db');
    
    // Check if the file exists
    if (fs.existsSync(dbPath)) {
      const stats = fs.statSync(dbPath);
      return NextResponse.json({ 
        timestamp: stats.mtime.toISOString() 
      });
    }
    
    return NextResponse.json({ timestamp: null });
  } catch (error) {
    console.error('Error getting last updated time:', error);
    return NextResponse.json({ error: 'Failed to get last updated time' }, { status: 500 });
  }
}