// THIS IS THE HOMPEPAGE FILE
import Link from "next/link";
import styles from "../styles/home.module.css";

export default function HomePage() {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Blockworks Dashboard</h1>
        <p className={styles.subtitle}>
          Tracking Team Holdings and Market Movements
        </p>
      </header>
      
      <div className={styles.content}>
        <div className={styles.infoCard}>
          <h2>About This Dashboard</h2>
          <p>
            This dashboard provides insights into Blockworks team holdings across various 
            assets including cryptocurrencies, NFTs, and equities. Data is sourced directly 
            from Blockworks&apos; financial disclosures page.
          </p>
        </div>
        
        <div className={styles.grid}>
          <Link href="/holdings" className={styles.card}>
            <h2>📊 View Holdings</h2>
            <p>
              Browse and filter team holdings across different asset classes. See who holds what
              and explore trends.
            </p>
          </Link>
          
          <a 
            href="https://blockworks.co/financial-disclosures" 
            target="_blank" 
            rel="noopener noreferrer" 
            className={styles.card}
          >
            <h2>🔍 Blockworks Disclosures</h2>
            <p>
              View the original financial disclosures published by Blockworks on their website.
            </p>
          </a>
        </div>
      </div>
      
      <footer className={styles.footer}>
        <p>
          Data is updated regularly from the official Blockworks disclosure page. 
          This dashboard is for informational purposes only.
        </p>
      </footer>
    </div>
  );
}
