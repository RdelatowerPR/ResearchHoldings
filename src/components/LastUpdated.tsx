// src/components/LastUpdated.tsx
'use client';

import { useEffect, useState } from 'react';

const LastUpdated = () => {
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  
  useEffect(() => {
    // Fetch the last updated time from an API endpoint
    fetch('/api/last-updated')
      .then(res => res.json())
      .then(data => {
        if (data.timestamp) {
          setLastUpdated(new Date(data.timestamp).toLocaleString());
        }
      })
      .catch(err => console.error('Error fetching last updated time:', err));
  }, []);
  
  if (!lastUpdated) return null;
  
  return (
    <div className="last-updated">
      <small>Data last updated: {lastUpdated}</small>
      <style jsx>{`
        .last-updated {
          text-align: center;
          color: #666;
          margin: 10px 0;
        }
      `}</style>
    </div>
  );
};

export default LastUpdated;