import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    const metadataPath = path.resolve(process.cwd(), 'data/metadata.json');
    
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        return NextResponse.json({ timestamp: metadata.lastUpdated });
      } catch (err) {
        console.error('Error parsing metadata:', err);
      }
    }
    
    // If metadata file doesn't exist or can't be parsed, return current time
    return NextResponse.json({ timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error getting last updated time:', error);
    // Fallback to current time
    return NextResponse.json({ timestamp: new Date().toISOString() });
  }
}