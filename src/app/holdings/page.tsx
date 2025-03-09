//This is the table for holdings page (clicking inside the homepage)

'use client';

import { useEffect, useState } from "react";
import styles from "../../styles/table.module.css";
import Link from "next/link";
import HoldingsAnalytics from "../../components/HoldingsAnalytics";

type Holding = {
  name: string;
  team: string;
  asset: string;
  asset_type: string;
  first_added: string;
  status: string;
  current_price?: number;
  price_date?: string;
};

type Stats = {
  totalHoldings: number;
  uniqueAssets: number;
  uniqueMembers: number;
  teams: {
    name: string;
    members: number;
    assets: number;
  }[];
};

export default function HoldingsPage() {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState({
    team: '',
    asset_type: '',
    name: ''
  });
  const [sortConfig, setSortConfig] = useState<{
    key: keyof Holding,
    direction: 'asc' | 'desc'
  }>({
    key: 'name',
    direction: 'asc'
  });
  const [activeTab, setActiveTab] = useState<'table' | 'analytics'>('table');

  useEffect(() => {
    setLoading(true);
    fetch("/api/holdings")
      .then((res) => {
        if (!res.ok) {
          throw new Error("Failed to fetch holdings data");
        }
        return res.json();
      })
      .then((data) => {
        // Handle both the old and new API response formats
        if (Array.isArray(data)) {
          // Old format - just an array of holdings
          setHoldings(data);
        } else if (data.holdings && Array.isArray(data.holdings)) {
          // New format - object with holdings and stats
          setHoldings(data.holdings);
          setStats(data.stats);
        } else {
          throw new Error("Unexpected data format from API");
        }
        setLoading(false);
      })
      .catch(err => {
        console.error("Error fetching data:", err);
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // Get unique values for filters
  const teams = [...new Set(holdings.map(h => h.team))];
  const assetTypes = [...new Set(holdings.map(h => h.asset_type))];
  const names = [...new Set(holdings.map(h => h.name))];

  // Handle sorting
  const requestSort = (key: keyof Holding) => {
    let direction: 'asc' | 'desc' = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // Apply filters and sorting
  const filteredAndSortedHoldings = [...holdings]
    .filter(holding => 
      (filter.team === '' || holding.team === filter.team) &&
      (filter.asset_type === '' || holding.asset_type === filter.asset_type) &&
      (filter.name === '' || holding.name === filter.name)
    )
    .sort((a, b) => {
      if (a[sortConfig.key] < b[sortConfig.key]) {
        return sortConfig.direction === 'asc' ? -1 : 1;
      }
      if (a[sortConfig.key] > b[sortConfig.key]) {
        return sortConfig.direction === 'asc' ? 1 : -1;
      }
      return 0;
    });

  // Create a summary of holdings by team if we don't have stats from the API
  const teamSummary = stats?.teams || teams.map(team => {
    const teamHoldings = holdings.filter(h => h.team === team);
    return {
      name: team,
      members: [...new Set(teamHoldings.map(h => h.name))].length,
      assets: [...new Set(teamHoldings.map(h => h.asset))].length
    };
  });
  
  if (loading) return <div className={styles.container}><p>Loading holdings data...</p></div>;
  if (error) return <div className={styles.container}><p>Error: {error}</p></div>;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>Blockworks Team Holdings</h1>
        <Link href="/" className={styles.backLink}>← Back to Home</Link>
      </div>
      
      <div className={styles.tabNavigation}>
        <button 
          className={`${styles.tabButton} ${activeTab === 'table' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('table')}
        >
          Table View
        </button>
        <button 
          className={`${styles.tabButton} ${activeTab === 'analytics' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('analytics')}
        >
          Analytics View
        </button>
      </div>
      
      {activeTab === 'table' ? (
        <>
          <div className={styles.filters}>
            <div className={styles.filterGroup}>
              <label htmlFor="teamFilter">Team:</label>
              <select 
                id="teamFilter"
                value={filter.team}
                onChange={(e) => setFilter({...filter, team: e.target.value})}
              >
                <option value="">All Teams</option>
                {teams.map(team => (
                  <option key={team} value={team}>{team}</option>
                ))}
              </select>
            </div>
            
            <div className={styles.filterGroup}>
              <label htmlFor="assetTypeFilter">Asset Type:</label>
              <select 
                id="assetTypeFilter"
                value={filter.asset_type}
                onChange={(e) => setFilter({...filter, asset_type: e.target.value})}
              >
                <option value="">All Types</option>
                {assetTypes.map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
            
            <div className={styles.filterGroup}>
              <label htmlFor="nameFilter">Team Member:</label>
              <select 
                id="nameFilter"
                value={filter.name}
                onChange={(e) => setFilter({...filter, name: e.target.value})}
              >
                <option value="">All Members</option>
                {names.sort().map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
            
            <button 
              className={styles.resetButton}
              onClick={() => setFilter({team: '', asset_type: '', name: ''})}
            >
              Reset Filters
            </button>
          </div>
          
          <div className={styles.summary}>
            <h2>Summary</h2>
            <div className={styles.summaryGrid}>
              {teamSummary.map(summary => (
                <div key={summary.name} className={styles.summaryCard}>
                  <h3>{summary.name}</h3>
                  <p>{summary.members} Members</p>
                  <p>{summary.assets} Assets</p>
                </div>
              ))}
            </div>
          </div>
          
          <p className={styles.resultCount}>
            Showing {filteredAndSortedHoldings.length} of {holdings.length} total holdings
          </p>
          
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th onClick={() => requestSort('name')} className={styles.sortable}>
                    Name {sortConfig.key === 'name' && (
                      <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                  <th onClick={() => requestSort('team')} className={styles.sortable}>
                    Team {sortConfig.key === 'team' && (
                      <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                  <th onClick={() => requestSort('asset')} className={styles.sortable}>
                    Asset {sortConfig.key === 'asset' && (
                      <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                  <th onClick={() => requestSort('asset_type')} className={styles.sortable}>
                    Type {sortConfig.key === 'asset_type' && (
                      <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                  <th onClick={() => requestSort('first_added')} className={styles.sortable}>
                    First Added {sortConfig.key === 'first_added' && (
                      <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                  {holdings.some(h => h.current_price) && (
                    <th onClick={() => requestSort('current_price')} className={styles.sortable}>
                      Current Price {sortConfig.key === 'current_price' && (
                        <span>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {filteredAndSortedHoldings.map((holding, index) => (
                  <tr key={index}>
                    <td>{holding.name}</td>
                    <td>{holding.team}</td>
                    <td>{holding.asset}</td>
                    <td>{holding.asset_type}</td>
                    <td>{new Date(holding.first_added).toLocaleDateString()}</td>
                    {holdings.some(h => h.current_price) && (
                      <td>
                        {holding.current_price 
                          ? `$${holding.current_price.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2
                            })}` 
                          : '-'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {filteredAndSortedHoldings.length === 0 && (
            <p className={styles.noResults}>No holdings match your filter criteria.</p>
          )}
        </>
      ) : (
        <HoldingsAnalytics holdings={holdings} />
      )}
    </div>
  );
}