// app/api/last-updated/route.ts
// In src/app/api/last-updated/route.ts
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const metadataPath = path.resolve(process.cwd(), 'data/metadata.json');
    
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      return NextResponse.json({ timestamp: metadata.lastUpdated });
    }
    
    // Fallback to checking the database file if metadata doesn't exist
    const dbPath = path.resolve(process.cwd(), 'data/holdings.db');
    if (fs.existsSync(dbPath)) {
      const stats = fs.statSync(dbPath);
      return NextResponse.json({ timestamp: stats.mtime.toISOString() });
    }
    
    return NextResponse.json({ timestamp: null });
  } catch (error) {
    console.error('Error getting last updated time:', error);
    return NextResponse.json({ error: 'Failed to get last updated time' }, { status: 500 });
  }
}