import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DB_IMPORT_DIR, DB_PATH, DB_SNAPSHOT_DIR } from "./config.ts";
import { db, listDbSnapshots } from "./db.ts";
import { migrationStatus, stageDbImport } from "./migrations.ts";

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function safeSnapshotName(value: string): string | null {
  const name = basename(value);
  return /^[a-zA-Z0-9._-]+\.sqlite$/.test(name) ? name : null;
}

export function getDbStatus() {
  const dbExists = existsSync(DB_PATH);
  const sizeBytes = dbExists ? statSync(DB_PATH).size : 0;
  return {
    dbPath: DB_PATH,
    sizeBytes,
    journalMode: String((db.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null)?.journal_mode || "unknown"),
    migrations: migrationStatus(db),
    snapshots: listDbSnapshots(),
    pendingImport: existsSync(join(DB_IMPORT_DIR, "pending-import.json")),
  };
}

export function exportSnapshot(note = "") {
  mkdirSync(DB_SNAPSHOT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}-chat-wapp.sqlite`;
  const filePath = join(DB_SNAPSHOT_DIR, filename);
  db.exec("PRAGMA wal_checkpoint(FULL)");
  db.exec(`VACUUM INTO ${quoteSqlString(filePath)}`);
  const sizeBytes = statSync(filePath).size;
  const snapshot = {
    id: crypto.randomUUID(),
    filename,
    kind: "manual" as const,
    sizeBytes,
    createdAt: Date.now(),
    note: note.trim() || null,
  };
  db.query(`
    INSERT INTO db_snapshots(id, filename, kind, size_bytes, created_at, note)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).run(snapshot.id, snapshot.filename, snapshot.kind, snapshot.sizeBytes, snapshot.createdAt, snapshot.note);
  return snapshot;
}

export function snapshotPath(filename: string): string | null {
  const safeName = safeSnapshotName(filename);
  if (!safeName) return null;
  const path = join(DB_SNAPSHOT_DIR, safeName);
  return existsSync(path) ? path : null;
}

export async function stageUploadedImport(file: File) {
  mkdirSync(DB_IMPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(DB_IMPORT_DIR, `${stamp}-uploaded.sqlite`);
  writeFileSync(filePath, Buffer.from(await file.arrayBuffer()));
  stageDbImport(filePath);
  return { sourcePath: filePath, restartRequired: true };
}

export function stageSnapshotImport(filename: string) {
  const path = snapshotPath(filename);
  if (!path) throw new Error("snapshot not found");
  mkdirSync(DB_IMPORT_DIR, { recursive: true });
  const stagedPath = join(DB_IMPORT_DIR, `${Date.now()}-${basename(path)}`);
  copyFileSync(path, stagedPath);
  stageDbImport(stagedPath);
  return { sourcePath: stagedPath, restartRequired: true };
}

export function clearPendingImport() {
  rmSync(join(DB_IMPORT_DIR, "pending-import.json"), { force: true });
}
