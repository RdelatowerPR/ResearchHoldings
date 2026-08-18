const fs = require("fs");
const path = require("path");

// Two kinds of backup, because they fail differently.
//
// 1. A rotated binary copy of holdings.db taken before each write. Local and
//    gitignored - it covers a run that corrupts the file mid-flight, and it's the
//    copy you want when the last commit is already bad.
//
// 2. A committed JSON snapshot of every holding. The .db is a binary blob that git
//    can store but not diff, so a wrong write is invisible in review and awkward to
//    unpick. The snapshot is text: the daily commit shows exactly which holdings
//    appeared or disappeared, and restoreFromSnapshot.js rebuilds the tables from it.

const BACKUP_DIR = process.env.BACKUP_DIR || "backups";
const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || "data/holdings-snapshot.json";
const KEEP_BACKUPS = 7;

/**
 * Copy the database aside before it is modified, keeping the most recent few.
 * Returns the backup path, or null if there was nothing to copy.
 */
function backupDatabase(dbFile, { dir = BACKUP_DIR, keep = KEEP_BACKUPS, logger = console } = {}) {
  const source = path.resolve(process.cwd(), dbFile);
  if (!fs.existsSync(source)) return null;

  try {
    const target = path.resolve(process.cwd(), dir);
    fs.mkdirSync(target, { recursive: true });

    // Millisecond stamps collide when two backups land in the same tick - on a fast
    // filesystem that silently overwrites the previous copy, so rotation quietly keeps
    // fewer than it promises. Disambiguate rather than lose a backup.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backup = path.join(target, `holdings-${stamp}.db`);
    for (let n = 1; fs.existsSync(backup); n++) {
      backup = path.join(target, `holdings-${stamp}-${n}.db`);
    }
    fs.copyFileSync(source, backup);

    // Rotate: keep the newest `keep` copies
    const existing = fs.readdirSync(target)
      .filter(name => name.startsWith("holdings-") && name.endsWith(".db"))
      .sort();

    existing.slice(0, Math.max(0, existing.length - keep)).forEach(name => {
      fs.unlinkSync(path.join(target, name));
    });

    logger.info(`Backed up the database to ${path.relative(process.cwd(), backup)} (keeping ${keep})`);
    return backup;
  } catch (error) {
    logger.warn(`Could not back up the database: ${error.message}`);
    return null;
  }
}

/**
 * Write the text snapshot that gets committed alongside the database.
 * Sorted so the daily diff shows real changes rather than row ordering.
 */
function writeSnapshot(db, { file = SNAPSHOT_FILE, meta = {}, logger = console } = {}) {
  const rows = db.prepare(`
    SELECT m.name, m.team, h.asset, h.asset_type, h.first_added, h.status, h.last_seen
    FROM holdings h
    JOIN members m ON h.member_id = m.id
    ORDER BY m.name, h.asset
  `).all();

  const snapshot = {
    generatedAt: new Date().toISOString(),
    ...meta,
    counts: {
      total: rows.length,
      active: rows.filter(r => r.status === "active").length,
      members: new Set(rows.map(r => r.name)).size,
    },
    holdings: rows,
  };

  const target = path.resolve(process.cwd(), file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(snapshot, null, 2) + "\n");

  logger.info(`Wrote ${rows.length} holdings to ${file}`);
  return snapshot;
}

function readSnapshot({ file = SNAPSHOT_FILE } = {}) {
  const target = path.resolve(process.cwd(), file);
  if (!fs.existsSync(target)) throw new Error(`No snapshot at ${file}`);

  const snapshot = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!Array.isArray(snapshot.holdings)) throw new Error(`${file} has no holdings array`);
  return snapshot;
}

/**
 * Rebuild members and holdings from a snapshot. Prices are left alone - they are
 * append-only history that the snapshot deliberately doesn't carry.
 */
function restoreFromSnapshot(db, snapshot, { logger = console } = {}) {
  const upsertMember = db.prepare(
    "INSERT INTO members (name, team) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET team = excluded.team"
  );
  const getMemberId = db.prepare("SELECT id FROM members WHERE name = ?");
  const upsertHolding = db.prepare(`
    INSERT INTO holdings (member_id, asset, asset_type, first_added, status, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(member_id, asset) DO UPDATE SET
      asset_type = excluded.asset_type,
      first_added = excluded.first_added,
      status = excluded.status,
      last_seen = excluded.last_seen
  `);

  db.exec("BEGIN TRANSACTION");
  try {
    let restored = 0;
    for (const row of snapshot.holdings) {
      upsertMember.run(row.name, row.team);
      const member = getMemberId.get(row.name);
      upsertHolding.run(member.id, row.asset, row.asset_type, row.first_added, row.status, row.last_seen);
      restored++;
    }
    db.exec("COMMIT");
    logger.info(`Restored ${restored} holdings from the snapshot.`);
    return restored;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = { backupDatabase, writeSnapshot, readSnapshot, restoreFromSnapshot, SNAPSHOT_FILE, BACKUP_DIR };
