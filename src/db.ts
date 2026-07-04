import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { DB_PATH } from "./config.ts";
import { applyPendingDbImport, runMigrations } from "./migrations.ts";

mkdirSync(dirname(DB_PATH), { recursive: true });
applyPendingDbImport();

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
runMigrations(db);

export type Session = {
  token: string;
  pubkey: string;
  expiresAt: number;
};

export type Chat = {
  id: string;
  pubkey: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type Message = {
  id: string;
  chatId: string;
  pubkey: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "complete" | "error";
  runId: string | null;
  createdAt: number;
};

export type AppSettings = {
  autopilotUrl: string;
  defaultPipeline: string;
  currentAutopilotTargetId: string;
  autopilotTargets: AutopilotTarget[];
};

export type AccessRole = "read" | "edit";

export type AccessRule = {
  pubkey: string;
  npub: string;
  role: AccessRole;
  createdAt: number;
};

export type AutopilotTarget = {
  id: string;
  label: string;
  url: string;
  defaultPipeline: string;
  createdAt: number;
  updatedAt: number;
};

export type DbSnapshot = {
  id: string;
  filename: string;
  kind: "manual" | "pre-migration" | "pre-import";
  sizeBytes: number;
  createdAt: number;
  note: string | null;
};

export function mapChat(row: Record<string, unknown>): Chat {
  return {
    id: String(row.id),
    pubkey: String(row.pubkey),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    chatId: String(row.chat_id),
    pubkey: String(row.pubkey),
    role: String(row.role) as Message["role"],
    content: String(row.content),
    status: String(row.status) as Message["status"],
    runId: row.run_id ? String(row.run_id) : null,
    createdAt: Number(row.created_at),
  };
}

export function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM app_settings WHERE key = ?1").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.query(`
    INSERT INTO app_settings(key, value, updated_at)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, Date.now());
}

export function mapAccessRule(row: Record<string, unknown>): AccessRule {
  return {
    pubkey: String(row.pubkey),
    npub: String(row.npub),
    role: String(row.role) as AccessRole,
    createdAt: Number(row.created_at),
  };
}

export function mapAutopilotTarget(row: Record<string, unknown>): AutopilotTarget {
  return {
    id: String(row.id),
    label: String(row.label),
    url: String(row.url).replace(/\/$/, ""),
    defaultPipeline: String(row.default_pipeline),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function listAutopilotTargets(): AutopilotTarget[] {
  const rows = db.query("SELECT * FROM autopilot_targets ORDER BY updated_at DESC, label ASC").all() as Record<string, unknown>[];
  return rows.map(mapAutopilotTarget);
}

export function getAutopilotTarget(id: string | null): AutopilotTarget | null {
  if (!id) return null;
  const row = db.query("SELECT * FROM autopilot_targets WHERE id = ?1").get(id) as Record<string, unknown> | null;
  return row ? mapAutopilotTarget(row) : null;
}

export function getCurrentAutopilotTarget(): AutopilotTarget {
  const currentId = getSetting("currentAutopilotTargetId");
  const selected = getAutopilotTarget(currentId);
  if (selected) return selected;
  const first = listAutopilotTargets()[0];
  if (!first) throw new Error("No Autopilot targets are configured");
  setSetting("currentAutopilotTargetId", first.id);
  return first;
}

export function upsertAutopilotTarget(input: {
  id?: string;
  label: string;
  url: string;
  defaultPipeline: string;
}): AutopilotTarget {
  const now = Date.now();
  const id = input.id?.trim() || crypto.randomUUID();
  db.query(`
    INSERT INTO autopilot_targets(id, label, url, default_pipeline, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      url = excluded.url,
      default_pipeline = excluded.default_pipeline,
      updated_at = excluded.updated_at
  `).run(id, input.label.trim(), input.url.replace(/\/$/, ""), input.defaultPipeline.trim(), now);
  return getAutopilotTarget(id)!;
}

export function deleteAutopilotTarget(id: string): void {
  db.query("DELETE FROM autopilot_targets WHERE id = ?1").run(id);
  if (getSetting("currentAutopilotTargetId") === id) {
    const next = listAutopilotTargets()[0];
    if (next) setSetting("currentAutopilotTargetId", next.id);
  }
}

export function mapDbSnapshot(row: Record<string, unknown>): DbSnapshot {
  return {
    id: String(row.id),
    filename: String(row.filename),
    kind: String(row.kind) as DbSnapshot["kind"],
    sizeBytes: Number(row.size_bytes),
    createdAt: Number(row.created_at),
    note: row.note == null ? null : String(row.note),
  };
}

export function listDbSnapshots(): DbSnapshot[] {
  const rows = db.query("SELECT * FROM db_snapshots ORDER BY created_at DESC LIMIT 100").all() as Record<string, unknown>[];
  return rows.map(mapDbSnapshot);
}
