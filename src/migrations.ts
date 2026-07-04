import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { DB_BACKUP_DIR, DB_IMPORT_DIR, DB_PATH, PIPELINE_NAME, WINGMAN_URL } from "./config.ts";

type Migration = {
  id: string;
  description: string;
  up: (db: Database) => void;
};

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function backupDatabase(db: Database, reason: string): string | null {
  if (!existsSync(DB_PATH)) return null;
  mkdirSync(DB_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(DB_BACKUP_DIR, `${stamp}-${reason}.sqlite`);
  db.exec("PRAGMA wal_checkpoint(FULL)");
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  return backupPath;
}

const migrations: Migration[] = [
  {
    id: "001_initial_chat_wapp_schema",
    description: "Initial local chat, auth, access, settings, and pipeline schema",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          pubkey TEXT PRIMARY KEY,
          npub TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS login_challenges (
          pubkey TEXT PRIMARY KEY,
          nonce TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          pubkey TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (pubkey) REFERENCES users(pubkey) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY,
          pubkey TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (pubkey) REFERENCES users(pubkey) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          pubkey TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'complete',
          run_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS pipeline_runs (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          user_message_id TEXT NOT NULL,
          assistant_message_id TEXT NOT NULL,
          trigger_status TEXT NOT NULL,
          autopilot_run_id TEXT,
          webhook_token TEXT NOT NULL,
          trigger_payload_json TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS access_rules (
          pubkey TEXT NOT NULL,
          npub TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('read', 'edit')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (pubkey, role)
        );
      `);
    },
  },
  {
    id: "002_compat_existing_demo_databases",
    description: "Bring early demo databases forward without breaking existing local data",
    up(db) {
      if (!hasColumn(db, "pipeline_runs", "trigger_payload_json")) {
        db.exec("ALTER TABLE pipeline_runs ADD COLUMN trigger_payload_json TEXT");
      }
      db.query("DELETE FROM access_rules WHERE role = 'login'").run();
    },
  },
  {
    id: "003_named_autopilot_targets",
    description: "Store named Autopilot targets and remember which target/pipeline served each run",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS autopilot_targets (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          url TEXT NOT NULL,
          default_pipeline TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      if (!hasColumn(db, "pipeline_runs", "autopilot_target_id")) {
        db.exec("ALTER TABLE pipeline_runs ADD COLUMN autopilot_target_id TEXT");
      }
      if (!hasColumn(db, "pipeline_runs", "autopilot_url")) {
        db.exec("ALTER TABLE pipeline_runs ADD COLUMN autopilot_url TEXT");
      }
      if (!hasColumn(db, "pipeline_runs", "pipeline_name")) {
        db.exec("ALTER TABLE pipeline_runs ADD COLUMN pipeline_name TEXT");
      }

      const now = Date.now();
      const existing = db.query("SELECT id FROM autopilot_targets LIMIT 1").get() as { id: string } | null;
      if (!existing) {
        const url = String((db.query("SELECT value FROM app_settings WHERE key = 'autopilotUrl'").get() as { value: string } | null)?.value || WINGMAN_URL).replace(/\/$/, "");
        const pipeline = String((db.query("SELECT value FROM app_settings WHERE key = 'defaultPipeline'").get() as { value: string } | null)?.value || PIPELINE_NAME);
        db.query(`
          INSERT INTO autopilot_targets(id, label, url, default_pipeline, created_at, updated_at)
          VALUES ('default', 'Default Autopilot', ?1, ?2, ?3, ?3)
        `).run(url, pipeline, now);
        db.query(`
          INSERT INTO app_settings(key, value, updated_at)
          VALUES ('currentAutopilotTargetId', 'default', ?1)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(now);
      }
    },
  },
  {
    id: "004_sqlite_snapshot_registry",
    description: "Track exported SQLite snapshots and staged imports",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS db_snapshots (
          id TEXT PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK(kind IN ('manual', 'pre-migration', 'pre-import')),
          size_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          note TEXT
        );
      `);
    },
  },
];

export function applyPendingDbImport(): void {
  const pendingPath = join(DB_IMPORT_DIR, "pending-import.json");
  if (!existsSync(pendingPath)) return;
  const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as { sourcePath?: string; requestedAt?: number };
  if (!pending.sourcePath || !existsSync(pending.sourcePath)) {
    rmSync(pendingPath, { force: true });
    throw new Error(`Pending SQLite import source is missing: ${pending.sourcePath || "(none)"}`);
  }

  mkdirSync(dirname(DB_PATH), { recursive: true });
  mkdirSync(DB_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (existsSync(DB_PATH)) {
    copyFileSync(DB_PATH, join(DB_BACKUP_DIR, `${stamp}-pre-import-file-copy.sqlite`));
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  }
  copyFileSync(pending.sourcePath, DB_PATH);
  rmSync(pendingPath, { force: true });
}

export function stageDbImport(sourcePath: string): void {
  mkdirSync(DB_IMPORT_DIR, { recursive: true });
  writeFileSync(join(DB_IMPORT_DIR, "pending-import.json"), JSON.stringify({ sourcePath, requestedAt: Date.now() }, null, 2));
}

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const appliedRows = db.query("SELECT id FROM schema_migrations").all() as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((row) => row.id));
  const pending = migrations.filter((migration) => !applied.has(migration.id));
  if (!pending.length) return;

  const backupPath = backupDatabase(db, "pre-migration");
  db.exec("BEGIN");
  try {
    for (const migration of pending) {
      migration.up(db);
      db.query("INSERT INTO schema_migrations(id, description, applied_at) VALUES (?1, ?2, ?3)")
        .run(migration.id, migration.description, Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  if (backupPath) {
    const filename = backupPath.split("/").at(-1) || backupPath;
    const size = statSync(backupPath).size;
    db.query(`
      INSERT OR IGNORE INTO db_snapshots(id, filename, kind, size_bytes, created_at, note)
      VALUES (?1, ?2, 'pre-migration', ?3, ?4, ?5)
    `).run(crypto.randomUUID(), filename, size, Date.now(), `Automatic backup before ${pending.length} migration(s)`);
  }
}

export function migrationStatus(db: Database) {
  const rows = db.query("SELECT id, description, applied_at FROM schema_migrations ORDER BY applied_at ASC").all() as Array<{
    id: string;
    description: string;
    applied_at: number;
  }>;
  return {
    applied: rows.map((row) => ({ id: row.id, description: row.description, appliedAt: row.applied_at })),
    latest: rows.at(-1)?.id || null,
    available: migrations.map((migration) => ({ id: migration.id, description: migration.description })),
  };
}
