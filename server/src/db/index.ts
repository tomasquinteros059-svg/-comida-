import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { baseDe, cerrarTodas, localActual, registrarEsquema } from './locales.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let esquemaEnCache: string | null = null;

const leerEsquema = (): string => {
  esquemaEnCache ??= fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  return esquemaEnCache;
};

/**
 * La base del local activo.
 *
 * Cual es el local viaja por contexto (ver db/locales.ts): asi el codigo de
 * negocio —las cuarenta funciones que llaman a `all`, `get` y `run`— no se
 * entera de que existen varios locales y no hay ningun parametro que alguien
 * se pueda olvidar de pasar.
 *
 * En una instalacion de un solo local esto devuelve siempre el mismo archivo,
 * exactamente como antes.
 */
export function db(): Database.Database {
  return baseDe(localActual());
}

// Se registra al cargar el modulo: asi da igual desde donde se abra una base
// —al dar de alta el local o al primer pedido— que el esquema queda aplicado.
registrarEsquema((handle) => aplicarEsquema(handle, leerEsquema()));

/**
 * Aplica el esquema, sentencia por sentencia y en el orden del archivo.
 *
 * Casi todo es `CREATE ... IF NOT EXISTS` y se puede correr en cada arranque,
 * pero SQLite no tiene `ADD COLUMN IF NOT EXISTS`: la segunda vez tira
 * "duplicate column name". Ese error puntual se ignora, que es exactamente lo
 * que significa "esa columna ya estaba".
 *
 * Va una por una y no de un saque justamente para respetar el orden: un indice
 * sobre una columna agregada con ALTER tiene que correr despues del ALTER, y
 * separar las sentencias por tipo rompe eso.
 *
 * El esquema no tiene triggers ni literales con punto y coma adentro, asi que
 * cortar por `;` alcanza. Si algun dia los tiene, esto hay que cambiarlo.
 */
function aplicarEsquema(handle: Database.Database, schema: string): void {
  const sentencias = schema
    // Los comentarios de linea se van primero: pueden tener `;` adentro.
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sentencia of sentencias) {
    try {
      handle.exec(sentencia);
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err);
      if (/duplicate column name/i.test(mensaje)) continue;
      throw new Error(`No se pudo aplicar el esquema en:\n${sentencia.slice(0, 160)}\n${mensaje}`);
    }
  }
}

/** Ejecuta `fn` dentro de una transaccion. Cualquier throw revierte todo. */
export function transaction<T>(fn: () => T): T {
  return db().transaction(fn)();
}

export function closeDb(): void {
  cerrarTodas();
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
