import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const handle = new Database(config.databasePath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  handle.exec(schema);

  instance = handle;
  return instance;
}

/** Ejecuta `fn` dentro de una transaccion. Cualquier throw revierte todo. */
export function transaction<T>(fn: () => T): T {
  return db().transaction(fn)();
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

// ── Helpers tipados sobre better-sqlite3 ────────────────────────────────────

export const all = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] =>
  db().prepare(sql).all(...(params as never[])) as T[];

export const get = <T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined =>
  db().prepare(sql).get(...(params as never[])) as T | undefined;

export const run = (sql: string, params: unknown[] = []) =>
  db().prepare(sql).run(...(params as never[]));

// SQLite no tiene booleanos: guardamos 0/1.
export const toDbBool = (v: unknown): number => (v ? 1 : 0);
export const fromDbBool = (v: unknown): boolean => v === 1 || v === true;

export const jsonParse = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

// ── Ajustes del local ───────────────────────────────────────────────────────

export function getSetting(key: string, fallback = ''): string {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value],
  );
}

export function allSettings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
