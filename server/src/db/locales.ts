import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { badRequest, conflict } from '../lib/http.js';

/**
 * Varios locales en la misma instalación.
 *
 * Cada local tiene su PROPIO archivo SQLite. No hay una columna `local_id` en
 * cada tabla, y eso es a propósito: con una columna, una sola consulta a la que
 * se le olvidó el filtro muestra los pedidos de otro local. Es el peor error
 * posible en este producto y no se detecta mirando la pantalla —los datos se
 * ven bien, solo que son de otro—. Con un archivo por local ese error no se
 * puede cometer: la consulta no tiene forma de llegar a la otra base.
 *
 * Qué local es se resuelve por el dominio con el que entraron, y viaja por
 * AsyncLocalStorage: así el código de negocio no se entera de que esto existe
 * y no hay cuarenta funciones a las que pasarles un parámetro.
 */

export interface Local {
  slug: string;
  nombre: string;
  /** Dominios que entran a este local. Vacío = solo por el slug. */
  hosts: string[];
  /**
   * El identificador del número de WhatsApp de este local (el
   * `phone_number_id` de Meta).
   *
   * Va acá y no en las variables de entorno porque NO es una credencial: es
   * un identificador público que Meta manda en cada webhook, y es lo único
   * que dice a qué local pertenece un mensaje. El token, que sí es una
   * credencial, sigue afuera de la base.
   */
  whatsapp_id: string;
  activo: boolean;
  creado: string;
}

const contexto = new AsyncLocalStorage<string>();

/** El local por defecto: la instalación de un solo local sigue igual que antes. */
export const SLUG_POR_DEFECTO = 'principal';

// ── Registro ────────────────────────────────────────────────────────────────

let registro: Database.Database | null = null;

/** Donde viven las bases: al lado de la del local único. */
const carpetaDeDatos = () => path.dirname(config.databasePath);

function abrirRegistro(): Database.Database {
  if (registro) return registro;
  fs.mkdirSync(carpetaDeDatos(), { recursive: true });
  const handle = new Database(path.join(carpetaDeDatos(), 'locales.db'));
  handle.pragma('journal_mode = WAL');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS locales (
      slug    TEXT PRIMARY KEY,
      nombre  TEXT NOT NULL,
      hosts   TEXT NOT NULL DEFAULT '[]',
      activo  INTEGER NOT NULL DEFAULT 1,
      creado  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Se agrega aparte para no romper los registros que ya existen. Falla si la
  // columna ya está, que es lo normal a partir de la segunda vez.
  try {
    handle.exec(`ALTER TABLE locales ADD COLUMN whatsapp_id TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Ya estaba.
  }
  registro = handle;
  return handle;
}

export function cerrarRegistro(): void {
  registro?.close();
  registro = null;
}

const mapear = (fila: {
  slug: string;
  nombre: string;
  hosts: string;
  whatsapp_id?: string;
  activo: number;
  creado: string;
}): Local => ({
  slug: fila.slug,
  nombre: fila.nombre,
  hosts: JSON.parse(fila.hosts || '[]') as string[],
  whatsapp_id: fila.whatsapp_id ?? '',
  activo: fila.activo === 1,
  creado: fila.creado,
});

/**
 * El local principal tiene que estar SIEMPRE en el registro.
 *
 * Si fuera implicito, dar de alta el primer local extra dejaria un registro con
 * una sola fila —la nueva— y todo el trafico se iria ahi: el local original
 * dejaria de ver su propia carta y sus propios pedidos, sin ningun error. Ya
 * paso una vez, y por eso esto se arregla solo en vez de depender de que
 * alguien se acuerde.
 */
function asegurarPrincipal(): void {
  const handle = abrirRegistro();
  const hay = handle.prepare('SELECT COUNT(*) AS n FROM locales').get() as { n: number };
  if (hay.n > 0) return;
  handle
    .prepare('INSERT OR IGNORE INTO locales (slug, nombre, hosts) VALUES (?,?,?)')
    .run(SLUG_POR_DEFECTO, 'Principal', '[]');
}

export function listarLocales(): Local[] {
  asegurarPrincipal();
  return abrirRegistro()
    .prepare('SELECT * FROM locales ORDER BY nombre')
    .all()
    .map((f) => mapear(f as never));
}

export function obtenerLocal(slug: string): Local | undefined {
  const fila = abrirRegistro().prepare('SELECT * FROM locales WHERE slug = ?').get(slug);
  return fila ? mapear(fila as never) : undefined;
}

/** El slug: minúsculas, sin acentos, sin espacios. Es parte de una ruta. */
export const aSlug = (texto: string): string =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export function crearLocal(input: { nombre: string; slug?: string; hosts?: string[] }): Local {
  const slug = aSlug(input.slug || input.nombre);
  if (slug.length < 2) throw badRequest('El nombre del local es muy corto');
  if (obtenerLocal(slug)) throw conflict(`Ya hay un local con el nombre "${slug}"`);

  // Un dominio no puede apuntar a dos locales: el pedido terminaría en la
  // cocina equivocada.
  for (const host of input.hosts ?? []) {
    const duenio = localPorHost(host);
    if (duenio) throw conflict(`"${host}" ya lleva al local "${duenio.nombre}"`);
  }

  abrirRegistro()
    .prepare('INSERT INTO locales (slug, nombre, hosts) VALUES (?,?,?)')
    .run(slug, input.nombre.trim(), JSON.stringify(input.hosts ?? []));

  // Se abre la base ahora para que el esquema quede aplicado y el local ya
  // esté listo cuando alguien entre, en vez de en medio del primer pedido.
  baseDe(slug);
  return obtenerLocal(slug)!;
}

export function actualizarLocal(
  slug: string,
  cambio: Partial<Pick<Local, 'nombre' | 'hosts' | 'activo' | 'whatsapp_id'>>,
): Local {
  const actual = obtenerLocal(slug);
  if (!actual) throw badRequest(`No existe el local "${slug}"`);

  for (const host of cambio.hosts ?? []) {
    const duenio = localPorHost(host);
    if (duenio && duenio.slug !== slug) throw conflict(`"${host}" ya lleva al local "${duenio.nombre}"`);
  }

  const whatsapp = cambio.whatsapp_id?.trim() ?? actual.whatsapp_id;
  if (whatsapp) {
    // Dos locales con el mismo número no se puede: los mensajes de uno
    // caerían en la cocina del otro, y ese es el bug que esto viene a evitar.
    const duenio = localPorWhatsapp(whatsapp);
    if (duenio && duenio.slug !== slug) {
      throw conflict(`Ese número de WhatsApp ya es del local "${duenio.nombre}"`);
    }
  }

  abrirRegistro()
    .prepare('UPDATE locales SET nombre = ?, hosts = ?, activo = ?, whatsapp_id = ? WHERE slug = ?')
    .run(
      cambio.nombre?.trim() ?? actual.nombre,
      JSON.stringify(cambio.hosts ?? actual.hosts),
      (cambio.activo ?? actual.activo) ? 1 : 0,
      whatsapp,
      slug,
    );
  return obtenerLocal(slug)!;
}

/**
 * A qué local pertenece un número de WhatsApp.
 *
 * Meta manda todos los webhooks a la MISMA dirección, así que el dominio —que
 * es como se rutea todo lo demás— no sirve: para Meta el Host es siempre el
 * mismo. Lo único que distingue un local de otro en el cuerpo del webhook es
 * el `phone_number_id`. Sin esto, con dos locales dados de alta, los pedidos
 * de los dos caen en la cocina del primero.
 */
export function localPorWhatsapp(phoneNumberId: string): Local | undefined {
  const limpio = phoneNumberId.trim();
  if (!limpio) return undefined;
  return listarLocales().find((l) => l.whatsapp_id === limpio);
}

/** A qué local lleva un dominio. */
export function localPorHost(host: string): Local | undefined {
  const limpio = host.toLowerCase().split(':')[0] ?? '';
  if (!limpio) return undefined;
  return listarLocales().find((l) => l.hosts.some((h) => h.toLowerCase() === limpio));
}

/** true cuando hay más de un local dado de alta. */
export const hayVariosLocales = (): boolean => listarLocales().length > 1;

// ── Las bases ───────────────────────────────────────────────────────────────

const abiertas = new Map<string, Database.Database>();

/**
 * Como se arma una base vacia. Lo registra db/index.ts al cargarse: locales.ts
 * no tiene por que saber que hay un schema.sql, y asi no importa desde donde se
 * abra una base —al crear el local o al primer pedido— siempre queda aplicado.
 */
let aplicarEsquemaEnBaseNueva: ((handle: Database.Database) => void) | null = null;

export function registrarEsquema(fn: (handle: Database.Database) => void): void {
  aplicarEsquemaEnBaseNueva = fn;
}

/** El archivo de cada local. El principal mantiene la ruta de siempre. */
export function rutaDe(slug: string): string {
  if (slug === SLUG_POR_DEFECTO) return config.databasePath;
  const base = path.basename(config.databasePath, path.extname(config.databasePath));
  return path.join(carpetaDeDatos(), `${base}-${slug}.db`);
}

/**
 * La conexión de un local. Se crea al primer uso y queda abierta: son archivos
 * chicos y un local tiene un solo proceso.
 */
export function baseDe(slug: string): Database.Database {
  const yaAbierta = abiertas.get(slug);
  if (yaAbierta) return yaAbierta;

  const ruta = rutaDe(slug);
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const handle = new Database(ruta);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');

  if (!aplicarEsquemaEnBaseNueva) {
    handle.close();
    // Pasa si alguien abre una base sin haber cargado db/index.ts. Sin esto, la
    // base queda vacia y el error que aparece es "no such table: categories",
    // que no dice nada de lo que realmente paso.
    throw new Error(
      'Se intento abrir la base de un local antes de registrar el esquema. ' +
        'Importa db/index.ts antes de usar locales.',
    );
  }
  aplicarEsquemaEnBaseNueva(handle);

  abiertas.set(slug, handle);
  return handle;
}

export function cerrarTodas(): void {
  for (const handle of abiertas.values()) handle.close();
  abiertas.clear();
  cerrarRegistro();
}

export const estaAbierta = (slug: string): boolean => abiertas.has(slug);

// ── El local de este pedido ─────────────────────────────────────────────────

/** Corre `fn` con ese local como el activo. Todo lo de adentro usa su base. */
export const enLocal = <T>(slug: string, fn: () => T): T => contexto.run(slug, fn);

/** Cuál es el local activo. Sin contexto, el principal. */
export const localActual = (): string => contexto.getStore() ?? SLUG_POR_DEFECTO;

/**
 * Corre `fn` una vez por local. Es para las tareas de fondo —el barrido de
 * conversaciones, la limpieza de mensajes— que corren fuera de todo pedido y
 * si no solo tocarían el local principal.
 */
export function porCadaLocal<T>(fn: (slug: string) => T): Array<{ slug: string; resultado?: T; error?: unknown }> {
  const locales = listarLocales();
  const slugs = locales.length ? locales.filter((l) => l.activo).map((l) => l.slug) : [SLUG_POR_DEFECTO];
  return slugs.map((slug) => {
    try {
      return { slug, resultado: enLocal(slug, () => fn(slug)) };
    } catch (error) {
      return { slug, error };
    }
  });
}
