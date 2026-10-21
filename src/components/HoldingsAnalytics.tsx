'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import styles from '../styles/analytics.module.css';


type AssetMetric = {
  asset: string;
  holderCount: number;
  earliestAdded: string;
  avgMonthsHeld: string;
  monthlyPriceChange: number | null;
  totalPriceChange: number | null;
  currentPrice: number | null;
};

type TeamMetric = {
  team: string;
  memberCount: number;
  assetCount: number;
  bestMonthlyAsset: string | null;
  bestMonthlyChange: number | null;
  bestTotalAsset: string | null;
  bestTotalChange: number | null;
};

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

// One entry per priced asset in an active holding (built by src/lib/priceSummary.js)
type AssetPrices = {
  asset: string;
  latest: number;
  monthAgo: number | null;
  sinceAdded: Record<string, number>;
};

type TeamPerformance = {
  team: string;
  monthlyReturn: number | null;
  totalReturn: number | null;
  assetCount: number;
  assets: {
    asset: string;
    weight: number;
    monthlyChange: number | null;
    totalChange: number | null;
  }[];
};

type AnalyticsProps = {
  holdings: Holding[];
};

const PRICE_HISTORY_URL = '/api/holdings/price-history';

const HoldingsAnalytics: React.FC<AnalyticsProps> = ({ holdings }) => {
  const [selectedTeam, setSelectedTeam] = useState<string>('All');
  const [assetMetrics, setAssetMetrics] = useState<AssetMetric[]>([]);
  const [teamMetrics, setTeamMetrics] = useState<TeamMetric[]>([]);
  const [topAssets, setTopAssets] = useState<AssetMetric[]>([]);
  const [teamPerformance, setTeamPerformance] = useState<TeamPerformance[]>([]);
  const [assetPrices, setAssetPrices] = useState<Map<string, AssetPrices>>(new Map());
  const [priceError, setPriceError] = useState<string | null>(null);
  const [loadingPrices, setLoadingPrices] = useState<boolean>(true);
  
  // Fetch price history data
  useEffect(() => {
    const fetchPriceHistory = async () => {
      try {
        setLoadingPrices(true);
        const response = await fetch(PRICE_HISTORY_URL);
        if (!response.ok) {
          throw new Error(`${PRICE_HISTORY_URL} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
        }
        
        const data = await response.json();
        if (!Array.isArray(data.assets)) {
          throw new Error(`${PRICE_HISTORY_URL} returned no price list`);
        }
        
        setAssetPrices(new Map(data.assets.map((prices: AssetPrices) => [prices.asset, prices])));
      } catch (error) {
        // Shown in place of the price columns, so a failure is not mistaken for missing data
        console.error('Error fetching price history:', error);
        setPriceError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoadingPrices(false);
      }
    };
    
    fetchPriceHistory();
  }, []);
  
  // Get unique teams
  const teams = useMemo(() => 
    ['All', ...new Set(holdings.map(h => h.team))], 
    [holdings]
  );

  // Calculate months held
  const calculateMonthsHeld = (firstAdded: string) => {
    const addedDate = new Date(firstAdded);
    const today = new Date();
    return (
      (today.getFullYear() - addedDate.getFullYear()) * 12 + 
      today.getMonth() - addedDate.getMonth()
    );
  };
  
  // Calculate price change percentages
  const calculatePriceChanges = useCallback((asset: string, firstAdded: string) => {
    const prices = assetPrices.get(asset);
    if (!prices) {
      // Return null values if we don't have real price history
      return { 
        monthlyChange: null, 
        sinceAddedChange: null,
        currentPrice: null, 
        lastMonthPrice: null, 
        initialPrice: null
      };
    }
    
    // Current price
    const currentPrice = prices.latest;
    
    // Price 30 days before the current one; null (N/A) with less price history than that
    const lastMonthPrice = prices.monthAgo;
    
    // Price when first added: the first price on or after first_added, or the oldest
    // price when there is none
    const initialPrice = prices.sinceAdded[firstAdded] ?? null;
    
    // Calculate price changes
    const monthlyChange = lastMonthPrice && currentPrice
      ? ((currentPrice - lastMonthPrice) / lastMonthPrice) * 100 
      : null;
      
    const sinceAddedChange = initialPrice && currentPrice 
      ? ((currentPrice - initialPrice) / initialPrice) * 100 
      : null;
    
    return { 
      monthlyChange,
      sinceAddedChange,
      currentPrice, 
      lastMonthPrice, 
      initialPrice
    };
  }, [assetPrices]);
  
  useEffect(() => {
    const calculateMetrics = () => {
      // Filter holdings by selected team
      const filteredHoldings = selectedTeam === 'All'
        ? holdings
        : holdings.filter(h => h.team === selectedTeam);
      
      // Group by asset
      const assetGroups = filteredHoldings.reduce((acc, holding) => {
        if (!acc[holding.asset]) {
          acc[holding.asset] = [];
        }
        acc[holding.asset].push(holding);
        return acc;
      }, {} as Record<string, Holding[]>);
      
      // Calculate metrics for each asset
      const assetMetricsData = Object.entries(assetGroups).map(([asset, assetHoldings]) => {
        // Get the holding with the earliest first_added date for this asset
        const earliestHolding = assetHoldings.reduce((earliest, holding) => {
          return new Date(holding.first_added) < new Date(earliest.first_added) ? holding : earliest;
        });
        const earliestAdded = new Date(earliestHolding.first_added);
        
        // Count holders
        const holderCount = assetHoldings.length;
        
        // Calculate average months held
        const avgMonthsHeld = assetHoldings.reduce((sum, holding) => {
          return sum + calculateMonthsHeld(holding.first_added);
        }, 0) / holderCount;
        
        // Get price changes (real only, no mocks)
        const priceChanges = calculatePriceChanges(asset, earliestHolding.first_added);
        
        return {
          asset,
          holderCount,
          earliestAdded: earliestAdded.toISOString(),
          avgMonthsHeld: avgMonthsHeld.toFixed(1),
          monthlyPriceChange: priceChanges.monthlyChange,
          totalPriceChange: priceChanges.sinceAddedChange,
          currentPrice: priceChanges.currentPrice
        };
      });
      
      // Sort by holder count (descending)
      assetMetricsData.sort((a, b) => b.holderCount - a.holderCount);
      setAssetMetrics(assetMetricsData);
      
      // Calculate team metrics
      const teamMetricsData = teams.filter(team => team !== 'All').map(team => {
        const teamHoldings = holdings.filter(h => h.team === team);
        const uniqueMembers = new Set(teamHoldings.map(h => h.name)).size;
        const uniqueAssets = new Set(teamHoldings.map(h => h.asset)).size;
        
        // Best performing assets
        const assetPerformance: Record<string, { monthly: number | null, total: number | null }> = {};
        
        teamHoldings.forEach(holding => {
          if (!assetPerformance[holding.asset]) {
            const priceChanges = calculatePriceChanges(holding.asset, holding.first_added);
            
            assetPerformance[holding.asset] = {
              monthly: priceChanges.monthlyChange,
              total: priceChanges.sinceAddedChange
            };
          }
        });
        
        // Find best monthly performer
        let bestMonthlyAsset = null;
        let bestMonthlyChange = -Infinity;
        
        // Find best overall performer
        let bestTotalAsset = null;
        let bestTotalChange = -Infinity;
        
        Object.entries(assetPerformance).forEach(([asset, performance]) => {
          if (performance.monthly !== null && performance.monthly > bestMonthlyChange) {
            bestMonthlyAsset = asset;
            bestMonthlyChange = performance.monthly;
          }
          
          if (performance.total !== null && performance.total > bestTotalChange) {
            bestTotalAsset = asset;
            bestTotalChange = performance.total;
          }
        });
        
        return {
          team,
          memberCount: uniqueMembers,
          assetCount: uniqueAssets,
          bestMonthlyAsset,
          bestMonthlyChange: bestMonthlyChange !== -Infinity ? bestMonthlyChange : null,
          bestTotalAsset,
          bestTotalChange: bestTotalChange !== -Infinity ? bestTotalChange : null
        };
      });
      
      setTeamMetrics(teamMetricsData);
      
      // Top assets across all teams (only those with actual price data)
      const assetsWithData = assetMetricsData.filter(asset => asset.totalPriceChange !== null);
      const topAssetsList = assetsWithData.length > 0
        ? [...assetsWithData]
            .sort((a, b) => (b.totalPriceChange || 0) - (a.totalPriceChange || 0))
            .slice(0, 5)
        : [];
        
      setTopAssets(topAssetsList);
      
      // Calculate combined team performance
      const calcTeamPerformance = () => {
        // Create "ALL" group and individual team groups
        const allTeams = ['All', ...teams.filter(t => t !== 'All')];
        
        return allTeams.map(team => {
          // Get all holdings for this team (or all teams if "All")
          const teamHoldings = team === 'All' 
            ? holdings 
            : holdings.filter(h => h.team === team);
          
          // Get unique assets in this team
          const teamAssets = Array.from(new Set(teamHoldings.map(h => h.asset)));
          
          // Calculate asset weight based on holder count
          const assetWeights = teamAssets.map(asset => {
            const holdersCount = teamHoldings.filter(h => h.asset === asset).length;
            const weight = holdersCount / teamHoldings.length;
            
            // Get price changes
            const earliestHolding = teamHoldings
              .filter(h => h.asset === asset)
              .reduce((earliest, holding) => {
                const holdingDate = new Date(holding.first_added);
                const earliestDate = new Date(earliest.first_added);
                return holdingDate < earliestDate ? holding : earliest;
              });
              
            const priceChanges = calculatePriceChanges(asset, earliestHolding.first_added);
            
            return {
              asset,
              weight,
              monthlyChange: priceChanges.monthlyChange,
              totalChange: priceChanges.sinceAddedChange,
            };
          });
          
          // Calculate team's weighted performance
          let monthlyReturn = null;
          let totalReturn = null;
          
          // Filter out assets with no monthly change (less than 30 days of prices)
          const assetsWithPriceData = assetWeights.filter(a => a.monthlyChange !== null);
          
          if (assetsWithPriceData.length > 0) {
            // Normalize weights for assets with price data
            const totalWeight = assetsWithPriceData.reduce((sum, a) => sum + a.weight, 0);
            
            // Calculate weighted returns
            monthlyReturn = assetsWithPriceData.reduce((sum, asset) => {
              const normalizedWeight = totalWeight > 0 ? asset.weight / totalWeight : 0;
              return sum + (asset.monthlyChange || 0) * normalizedWeight;
            }, 0);
          }
            
          // Total return covers every asset with total change data, including those too
          // new for a monthly change
          const assetsWithTotalData = assetWeights.filter(a => a.totalChange !== null);
          if (assetsWithTotalData.length > 0) {
            const totalDataWeight = assetsWithTotalData.reduce((sum, a) => sum + a.weight, 0);
              
            totalReturn = assetsWithTotalData.reduce((sum, asset) => {
              const normalizedWeight = totalDataWeight > 0 ? asset.weight / totalDataWeight : 0;
              return sum + (asset.totalChange || 0) * normalizedWeight;
            }, 0);
          }
          
          return {
            team,
            monthlyReturn,
            totalReturn,
            assetCount: teamAssets.length,
            assets: assetWeights
          };
        });
      };
      
      setTeamPerformance(calcTeamPerformance());
    };
    
    if (!loadingPrices) {
      calculateMetrics();
    }
  }, [holdings, selectedTeam, assetPrices, teams, loadingPrices, calculatePriceChanges]);
  
  // Check if we have any price data
  const hasPriceData = assetPrices.size > 0;
  
  return (
    <div className={styles.analytics}>
      <h2 className={styles.sectionTitle}>Holdings Analytics</h2>
      
      {loadingPrices ? (
        <div className={styles.loading}>Loading price data...</div>
      ) : (
        <>
          <div className={styles.teamSelector}>
            <label htmlFor="teamSelect">Select Team: </label>
            <select 
              id="teamSelect" 
              value={selectedTeam} 
              onChange={(e) => setSelectedTeam(e.target.value)}
            >
              {teams.map(team => (
                <option key={team} value={team}>{team}</option>
              ))}
            </select>
          </div>
          
          {priceError && (
            <div className={styles.priceError} role="alert">
              <p><strong>Price data failed to load:</strong> {priceError}. Price-related metrics are hidden.</p>
            </div>
          )}
          
          {!priceError && !hasPriceData && (
            <div className={styles.noPriceData}>
              <p><strong>No price data available.</strong> Run your price fetching script to see price-related metrics.</p>
            </div>
          )}
          
          {/* Team Performance Dashboard Section */}
          {hasPriceData && (
            <div className={styles.performanceDashboard}>
              <h3>Team Combined Performance</h3>
              <div className={styles.metricsCard}>
                <table className={styles.metricsTable}>
                  <thead>
                    <tr>
                      <th>Team</th>
                      <th>Assets</th>
                      <th>Monthly Return</th>
                      <th>Total Return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamPerformance.map(perf => (
                      <tr key={perf.team}>
                        <td><strong>{perf.team}</strong></td>
                        <td>{perf.assetCount}</td>
                        <td className={perf.monthlyReturn && perf.monthlyReturn > 0 ? styles.positive : styles.negative}>
                          {perf.monthlyReturn !== null 
                            ? `${perf.monthlyReturn.toFixed(2)}%` 
                            : 'N/A'}
                        </td>
                        <td className={perf.totalReturn && perf.totalReturn > 0 ? styles.positive : styles.negative}>
                          {perf.totalReturn !== null 
                            ? `${perf.totalReturn.toFixed(2)}%` 
                            : 'N/A'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          
          <div className={styles.metricsGrid}>
            <div className={styles.metricsCard}>
              <h3>Top Assets by Holders ({selectedTeam})</h3>
              <table className={styles.metricsTable}>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Holders</th>
                    <th>Avg. Months Held</th>
                    {hasPriceData && (
                      <>
                        <th>Monthly Change</th>
                        <th>Total Change</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {assetMetrics.slice(0, 10).map(metric => (
                    <tr key={metric.asset}>
                      <td>{metric.asset}</td>
                      <td>{metric.holderCount}</td>
                      <td>{metric.avgMonthsHeld}</td>
                      {hasPriceData && (
                        <>
                          <td className={metric.monthlyPriceChange > 0 ? styles.positive : styles.negative}>
                            {metric.monthlyPriceChange !== null ? 
                              `${metric.monthlyPriceChange.toFixed(2)}%` : 'N/A'}
                          </td>
                          <td className={metric.totalPriceChange > 0 ? styles.positive : styles.negative}>
                            {metric.totalPriceChange !== null ? 
                              `${metric.totalPriceChange.toFixed(2)}%` : 'N/A'}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            {hasPriceData && topAssets.length > 0 && (
              <div className={styles.metricsCard}>
                <h3>Best Performing Assets</h3>
                <table className={styles.metricsTable}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Holders</th>
                      <th>First Added</th>
                      <th>Monthly Change</th>
                      <th>Total Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topAssets.map(asset => (
                      <tr key={asset.asset}>
                        <td>{asset.asset}</td>
                        <td>{asset.holderCount}</td>
                        <td>{new Date(asset.earliestAdded).toLocaleDateString()}</td>
                        <td className={asset.monthlyPriceChange > 0 ? styles.positive : styles.negative}>
                          {asset.monthlyPriceChange !== null ? 
                            `${asset.monthlyPriceChange.toFixed(2)}%` : 'N/A'}
                        </td>
                        <td className={asset.totalPriceChange > 0 ? styles.positive : styles.negative}>
                          {asset.totalPriceChange !== null ? 
                            `${asset.totalPriceChange.toFixed(2)}%` : 'N/A'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          
          <div className={styles.metricsCard}>
            <h3>Team Performance Metrics</h3>
            <table className={styles.metricsTable}>
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Members</th>
                  <th>Unique Assets</th>
                  {hasPriceData && (
                    <>
                      <th>Best Monthly Asset</th>
                      <th>Monthly Change</th>
                      <th>Best Overall Asset</th>
                      <th>Total Change</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {teamMetrics.map(metric => (
                  <tr key={metric.team}>
                    <td>{metric.team}</td>
                    <td>{metric.memberCount}</td>
                    <td>{metric.assetCount}</td>
                    {hasPriceData && (
                      <>
                        <td>{metric.bestMonthlyAsset || 'N/A'}</td>
                        <td className={metric.bestMonthlyChange > 0 ? styles.positive : styles.negative}>
                          {metric.bestMonthlyChange !== null ? 
                            `${metric.bestMonthlyChange.toFixed(2)}%` : 'N/A'}
                        </td>
                        <td>{metric.bestTotalAsset || 'N/A'}</td>
                        <td className={metric.bestTotalChange > 0 ? styles.positive : styles.negative}>
                          {metric.bestTotalChange !== null ? 
                            `${metric.bestTotalChange.toFixed(2)}%` : 'N/A'}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.metricsSection}>
            <h3>Individual Member Analysis</h3>
            <div className={styles.metricsCard}>
              <table className={styles.metricsTable}>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Team</th>
                    <th>Assets Held</th>
                    <th>Avg Hold Time</th>
                    {hasPriceData && (
                      <>
                        <th>Best Performing Asset</th>
                        <th>Performance</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {Array.from(new Set(holdings.map(h => h.name))).map(name => {
                    const memberHoldings = holdings.filter(h => h.name === name);
                    const team = memberHoldings[0].team;
                    const assetCount = memberHoldings.length;
                    
                    // Calculate average hold time
                    const avgHoldTime = memberHoldings.reduce((sum, holding) => {
                      return sum + calculateMonthsHeld(holding.first_added);
                    }, 0) / assetCount;
                    
                    // Find best performing asset (only if we have price data)
                    let bestAsset = '';
                    let bestPerformance = -Infinity;
                    
                    if (hasPriceData) {
                      memberHoldings.forEach(holding => {
                        const priceChanges = calculatePriceChanges(holding.asset, holding.first_added);
                        if (priceChanges.sinceAddedChange !== null && priceChanges.sinceAddedChange > bestPerformance) {
                          bestAsset = holding.asset;
                          bestPerformance = priceChanges.sinceAddedChange;
                        }
                      });
                    }
                    
                    return (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{team}</td>
                        <td>{assetCount}</td>
                        <td>{avgHoldTime.toFixed(1)} months</td>
                        {hasPriceData && (
                          <>
                            <td>{bestAsset || 'N/A'}</td>
                            <td className={bestPerformance > 0 ? styles.positive : styles.negative}>
                              {bestPerformance !== -Infinity ? 
                                `${bestPerformance.toFixed(2)}%` : 'N/A'}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          
          <div className={styles.disclaimer}>
            <p>
              <strong>Note:</strong> Price data is based on actual prices fetched from APIs.
              {hasPriceData && " Monthly Change compares the latest price with the price 30 days earlier, and is N/A for assets with less than 30 days of price history."}
              {!hasPriceData && !priceError && " No price data is currently available. Run the fetchPrices.js script to collect price information."}
            </p>
          </div>
        </>
      )}
    </div>
  );
};

export default HoldingsAnalytics;