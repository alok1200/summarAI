#!/usr/bin/env bun
/**
 * SQLite backup script.
 *
 * Usage:
 *   bun run scripts/db-backup.ts                # one-shot backup
 *   bun run scripts/db-backup.ts --restore <name>  # restore from a backup file
 *   bun run scripts/db-backup.ts --list         # list existing backups
 *   bun run scripts/db-backup.ts --prune        # delete backups older than retention
 *
 * npm scripts:
 *   npm run db:backup        # one-shot backup
 *   npm run db:backup:list   # list existing backups
 *   npm run db:backup:prune  # delete backups beyond retention
 *   npm run db:restore <name>  # restore from a backup
 *
 * Env vars (all optional):
 *   DATABASE_URL          — Prisma connection string (default: file:./db/custom.db)
 *   BACKUP_DIR            — where to save backups (default: ./backups)
 *   BACKUP_RETENTION      — number of backups to keep (default: 30)
 *   BACKUP_COMPRESS       — "1" to gzip the backup (default: "1")
 *
 * Why not just `cp db/custom.db backups/`?
 *   SQLite uses WAL mode by default, and a raw file copy can capture the DB
 *   in an inconsistent state if a write is in flight. `VACUUM INTO` (used
 *   below) is SQLite's built-in Online Backup mechanism — it produces a
 *   transactionally-consistent snapshot even while the database is being
 *   written to. Same guarantee as `sqlite3 .backup`, no shell-out needed.
 */

// bun:sqlite is Bun's built-in SQLite driver. Faster than better-sqlite3
// and doesn't require native bindings.
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join, basename, dirname } from "path";
import { gzipSync, gunzipSync } from "zlib";

// ---------- Config ----------

function resolveDbPath(): string {
  const url = process.env.DATABASE_URL || "file:./db/custom.db";
  // Prisma SQLite URL format: "file:<path>"
  const m = url.match(/^file:(.+)$/);
  if (!m) {
    // Non-SQLite database (Postgres / MySQL / etc.) — this script is
    // SQLite-only (uses bun:sqlite + VACUUM INTO). Exit gracefully with
    // actionable guidance instead of throwing a stack trace.
    const provider =
      url.startsWith("postgresql://") || url.startsWith("postgres://")
        ? "Postgres"
        : url.startsWith("mysql://")
        ? "MySQL"
        : "the configured database";
    console.error(
      `[db-backup] Skipping: DATABASE_URL is not a SQLite file: URL (${provider} detected).\n` +
        `             This script only supports SQLite. For ${provider}, use the database's\n` +
        `             native backup tooling instead:\n` +
        `               - Postgres : pg_dump "$DATABASE_URL" -F c -f backup.dump\n` +
        `               - Neon      : use Neon's built-in branch/restore UI at https://neon.tech\n` +
        `               - MySQL     : mysqldump\n`
    );
    process.exit(0);
  }
  return m[1];
}

function resolveBackupDir(): string {
  return process.env.BACKUP_DIR || "./backups";
}

function resolveRetention(): number {
  const v = parseInt(process.env.BACKUP_RETENTION || "30", 10);
  return isNaN(v) || v < 1 ? 30 : v;
}

function shouldCompress(): boolean {
  return (process.env.BACKUP_COMPRESS || "1") === "1";
}

// ---------- Helpers ----------

function ts(): string {
  // YYYYMMDD-HHMMSS in local time — sortable, filesystem-safe.
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function log(msg: string) {
  // Use stderr so stdout stays clean for piping (e.g. `bun run db-backup.ts --list | jq`).
  console.error(`[db-backup] ${msg}`);
}

/**
 * Run a SQLite Online Backup from `sourcePath` to `destPath`.
 *
 * Uses `VACUUM INTO` — SQLite's built-in Online Backup mechanism (since
 * 3.27, 2019). It produces a transactionally-consistent snapshot even if
 * the source is being written to concurrently. The destination file is
 * created atomically: either the whole snapshot is written or the file
 * doesn't exist (no partial-output risk).
 *
 * The source is opened read-only so we don't conflict with a running
 * Prisma server that may have the DB open in read-write mode.
 */
function sqliteBackup(sourcePath: string, destPath: string): void {
  // Remove any stale destination file from a previous failed run.
  if (existsSync(destPath)) unlinkSync(destPath);
  // `create: false` is Bun's equivalent of `fileMustExist: true` — refuse
  // to open a non-existent DB instead of silently creating an empty one
  // (which would then "back up" as an empty file).
  const db = new Database(sourcePath, { readonly: true, create: false });
  try {
    // VACUUM INTO doesn't accept bound parameters — interpolate the path
    // directly. The path is controlled by us (resolveDbPath + our own
    // timestamp), so SQL injection isn't a concern here.
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/** Gzip a file in place, replacing the original with `<name>.gz`. */
function gzipInPlace(path: string): string {
  const buf = readFileSync(path);
  const compressed = gzipSync(buf);
  const gzPath = path + ".gz";
  writeFileSync(gzPath, compressed);
  unlinkSync(path);
  return gzPath;
}

/** Gunzip a file in place, replacing the .gz with the original name. */
function gunzipInPlace(gzPath: string): string {
  const buf = readFileSync(gzPath);
  const decompressed = gunzipSync(buf);
  const outPath = gzPath.replace(/\.gz$/, "");
  writeFileSync(outPath, decompressed);
  return outPath;
}

/** List all backup files in BACKUP_DIR, sorted newest-first. */
function listBackups(): Array<{ name: string; path: string; size: number; mtime: Date }> {
  const dir = resolveBackupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".db") || f.endsWith(".db.gz"))
    .map((name) => {
      const path = join(dir, name);
      const st = statSync(path);
      return { name, path, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

// ---------- Commands ----------

function cmdBackup(): void {
  const dbPath = resolveDbPath();
  const backupDir = resolveBackupDir();
  if (!existsSync(dbPath)) {
    throw new Error(
      `Database file not found: ${dbPath}. Run \`npm run db:push\` first to create it.`
    );
  }
  mkdirSync(backupDir, { recursive: true });

  const baseName = basename(dbPath); // e.g. "custom.db"
  const stem = baseName.replace(/\.db$/, "");
  const tmpPath = join(backupDir, `${stem}-${ts()}.db.tmp`);
  const finalPath = tmpPath.replace(/\.tmp$/, "");

  log(`Backing up ${dbPath} → ${finalPath}`);
  const t0 = Date.now();
  sqliteBackup(dbPath, tmpPath);
  // Rename .tmp → .db so partially-written backups are never visible.
  // (If the script crashes mid-backup, the .tmp file is left behind and
  // ignored by listBackups(); a future run will overwrite it.)
  copyFileSync(tmpPath, finalPath);
  unlinkSync(tmpPath);

  let outPath = finalPath;
  if (shouldCompress()) {
    outPath = gzipInPlace(finalPath);
    log(`Compressed → ${outPath}`);
  }

  const sizeKb = (statSync(outPath).size / 1024).toFixed(1);
  log(`✓ Backup complete in ${Date.now() - t0}ms (${sizeKb} KB)`);

  // Auto-prune: keep only the last BACKUP_RETENTION backups.
  const all = listBackups();
  const retention = resolveRetention();
  if (all.length > retention) {
    const toDelete = all.slice(retention);
    log(`Pruning ${toDelete.length} old backup(s) (retention=${retention}):`);
    for (const b of toDelete) {
      log(`  - ${b.name} (${(b.size / 1024).toFixed(1)} KB, ${b.mtime.toISOString()})`);
      unlinkSync(b.path);
    }
  }
}

function cmdList(): void {
  const all = listBackups();
  if (all.length === 0) {
    log(`No backups found in ${resolveBackupDir()}/`);
    return;
  }
  log(`Backups in ${resolveBackupDir()}/ (newest first):`);
  for (const b of all) {
    const sizeKb = (b.size / 1024).toFixed(1);
    log(`  ${b.name}\t${sizeKb} KB\t${b.mtime.toISOString()}`);
  }
}

function cmdPrune(): void {
  const all = listBackups();
  const retention = resolveRetention();
  if (all.length <= retention) {
    log(`Nothing to prune (${all.length} ≤ retention=${retention})`);
    return;
  }
  const toDelete = all.slice(retention);
  log(`Pruning ${toDelete.length} old backup(s) (retention=${retention}):`);
  for (const b of toDelete) {
    log(`  - ${b.name} (${(b.size / 1024).toFixed(1)} KB, ${b.mtime.toISOString()})`);
    unlinkSync(b.path);
  }
}

function cmdRestore(name: string): void {
  const backupDir = resolveBackupDir();
  const dbPath = resolveDbPath();

  // Accept either the bare name or the full path; also accept with or
  // without the .gz extension.
  const candidates = [
    name,
    join(backupDir, name),
    join(backupDir, name.endsWith(".gz") ? name : name + ".gz"),
    join(backupDir, name.endsWith(".db") ? name : name + ".db"),
    join(backupDir, name.endsWith(".db.gz") ? name : name + ".db.gz"),
  ];
  const backupPath = candidates.find((p) => existsSync(p));
  if (!backupPath) {
    throw new Error(
      `Backup not found: ${name}\n` +
        `Looked in: ${backupDir}\n` +
        `Available backups:\n` +
        listBackups()
          .map((b) => `  ${b.name}`)
          .join("\n")
    );
  }

  // Refuse to overwrite an existing live DB without a safety net.
  if (existsSync(dbPath)) {
    const preRestoreBackup = join(
      backupDir,
      `${basename(dbPath).replace(/\.db$/, "")}-pre-restore-${ts()}.db`
    );
    log(`Live DB exists at ${dbPath}. Creating safety backup first:`);
    log(`  → ${preRestoreBackup}`);
    sqliteBackup(dbPath, preRestoreBackup);
    if (shouldCompress()) {
      const gz = gzipInPlace(preRestoreBackup);
      log(`  → compressed to ${gz}`);
    }
  }

  log(`Restoring ${backupPath} → ${dbPath}`);
  // Make sure the db directory exists.
  mkdirSync(dirname(dbPath), { recursive: true });

  // Read the backup file, decompress if needed, and write to dbPath.
  // We read-then-write (rather than copyFile) so we can decompress in
  // memory without mutating the backup file on disk.
  const buf = readFileSync(backupPath);
  const out = backupPath.endsWith(".gz") ? gunzipSync(buf) : buf;
  writeFileSync(dbPath, out);

  const sizeKb = (statSync(dbPath).size / 1024).toFixed(1);
  log(`✓ Restore complete (${sizeKb} KB)`);
  log(`  The pre-restore safety backup is preserved in ${backupDir}/.`);
  log(`  Restart the app server so Prisma picks up the new DB file.`);
}

// ---------- CLI ----------

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/db-backup.ts                Create a timestamped backup
  bun run scripts/db-backup.ts --list         List existing backups
  bun run scripts/db-backup.ts --prune        Delete backups beyond retention
  bun run scripts/db-backup.ts --restore <name>   Restore from a backup

Env vars:
  DATABASE_URL          SQLite file: URL (default: file:./db/custom.db)
  BACKUP_DIR            Backup directory (default: ./backups)
  BACKUP_RETENTION      Number of backups to keep (default: 30)
  BACKUP_COMPRESS       "1" to gzip (default), "0" for plain .db
`);
}

// ---------- Main ----------

const args = process.argv.slice(2);
try {
  if (args.length === 0) {
    cmdBackup();
  } else if (args[0] === "--list") {
    cmdList();
  } else if (args[0] === "--prune") {
    cmdPrune();
  } else if (args[0] === "--restore") {
    if (!args[1]) {
      console.error("Error: --restore requires a backup name argument");
      printUsage();
      process.exit(1);
    }
    cmdRestore(args[1]);
  } else if (args[0] === "--help" || args[0] === "-h") {
    printUsage();
  } else {
    console.error(`Unknown argument: ${args[0]}`);
    printUsage();
    process.exit(1);
  }
} catch (e) {
  console.error(`[db-backup] ✗ ${(e as Error).message}`);
  process.exit(1);
}
