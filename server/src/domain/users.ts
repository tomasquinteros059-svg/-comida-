import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { all, get, run, toDbBool } from '../db/index.js';
import { consultarPagina, type OpcionesDePagina, type Pagina } from '../lib/paginacion.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { normalize } from '../lib/text.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Roles del local. Estan pensados por lo que cada uno necesita ver, no por
 * jerarquia: la cocina no ve precios ni facturacion porque no los necesita
 * para cocinar, y ese es todo el criterio.
 */
export const ROLES = ['dueño', 'encargado', 'cocina'] as const;
export type Rol = (typeof ROLES)[number];

export const PERMISOS = [
  'ventas',   // panel, facturacion, reportes de carta
  'carta',    // productos y precios
  'stock',    // insumos y movimientos
  'compras',  // proveedores y ordenes de compra
  'cocina',   // tablero de comandas
  'bot',      // conocimiento del chatbot y conversaciones
  'usuarios', // dar de alta y baja gente
] as const;
export type Permiso = (typeof PERMISOS)[number];

const PERMISOS_POR_ROL: Record<Rol, readonly Permiso[]> = {
  'dueño': PERMISOS,
  encargado: ['ventas', 'carta', 'stock', 'compras', 'cocina', 'bot'],
  cocina: ['cocina'],
};

export const permisosDe = (rol: Rol): readonly Permiso[] => PERMISOS_POR_ROL[rol] ?? [];
export const puede = (rol: Rol, permiso: Permiso): boolean => permisosDe(rol).includes(permiso);

export interface Usuario {
  id: string;
  name: string;
  username: string;
  role: Rol;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
}

interface UsuarioRow extends Omit<Usuario, 'active'> {
  active: number;
  password_hash: string;
}

const mapUsuario = ({ password_hash: _omitido, ...row }: UsuarioRow): Usuario => ({
  ...row,
  active: row.active === 1,
});

// ── Contraseñas ─────────────────────────────────────────────────────────────

/**
 * scrypt con sal por usuario. Viene en Node, asi que no hay que sumar una
 * dependencia para lo unico que no se puede improvisar.
 */
async function hashear(clave: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(clave, salt, 64);
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function claveCorrecta(clave: string, guardado: string): Promise<boolean> {
  const [saltHex, hashHex] = guardado.split('$');
  if (!saltHex || !hashHex) return false;
  const hash = await scryptAsync(clave, Buffer.from(saltHex, 'hex'), 64);
  const esperado = Buffer.from(hashHex, 'hex');
  if (hash.length !== esperado.length) return false;
  return timingSafeEqual(hash, esperado);
}

/** Reglas minimas: que no sea trivial de adivinar ni imposible de tipear. */
export function validarClave(clave: string): void {
  if (clave.length < 8) throw badRequest('La clave tiene que tener al menos 8 caracteres');
  if (clave.length > 200) throw badRequest('La clave es demasiado larga');
  const comunes = ['12345678', 'password', 'contraseña', 'qwertyui', '11111111'];
  if (comunes.includes(clave.toLowerCase())) throw badRequest('Esa clave es muy fácil de adivinar');
}

const normalizarUsuario = (usuario: string) => normalize(usuario).replace(/\s+/g, '');

// ── Usuarios ────────────────────────────────────────────────────────────────

export const listarUsuarios = (): Usuario[] =>
  all<UsuarioRow>('SELECT * FROM users ORDER BY active DESC, name').map(mapUsuario);

export const contarUsuarios = (): number =>
  get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;

/**
 * Cuántos dueños activos hay. Con uno solo el local queda colgado de una
 * persona: si se va de vacaciones y pierde la clave, la única salida es el
 * token maestro del servidor, que casi nadie tiene a mano.
 */
export const cuantosDueños = (): number =>
  get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'dueño' AND active = 1")?.n ?? 0;

export const hayDueño = (): boolean =>
  (get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'dueño' AND active = 1")?.n ?? 0) > 0;

export function obtenerUsuario(id: string): Usuario | undefined {
  const row = get<UsuarioRow>('SELECT * FROM users WHERE id = ?', [id]);
  return row ? mapUsuario(row) : undefined;
}

export interface AltaUsuario {
  name: string;
  username: string;
  clave: string;
  role: Rol;
}

export async function crearUsuario(input: AltaUsuario): Promise<Usuario> {
  const username = normalizarUsuario(input.username);
  if (username.length < 3) throw badRequest('El nombre de usuario necesita al menos 3 letras');
  if (!ROLES.includes(input.role)) throw badRequest(`Rol desconocido: ${input.role}`);
  validarClave(input.clave);

  if (get('SELECT id FROM users WHERE username = ?', [username])) {
    throw conflict(`Ya hay alguien usando "${username}"`);
  }

  const id = newId('usr');
  run(
    'INSERT INTO users (id, name, username, password_hash, role) VALUES (?,?,?,?,?)',
    [id, input.name.trim(), username, await hashear(input.clave), input.role],
  );
  return obtenerUsuario(id)!;
}

export interface CambioUsuario {
  name?: string;
  role?: Rol;
  active?: boolean;
  clave?: string;
}

export async function actualizarUsuario(id: string, cambio: CambioUsuario): Promise<Usuario> {
  const actual = obtenerUsuario(id);
  if (!actual) throw notFound('Usuario');

  // El local no puede quedarse sin dueño: si no, nadie vuelve a entrar a la
  // pantalla de usuarios y hay que tocar la base a mano.
  const dejaDeSerDueño =
    actual.role === 'dueño' && ((cambio.role && cambio.role !== 'dueño') || cambio.active === false);
  if (dejaDeSerDueño && ultimoDueño(id)) {
    throw conflict('Es el único dueño activo: primero designá a otro');
  }

  if (cambio.clave !== undefined) {
    validarClave(cambio.clave);
    run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [
      await hashear(cambio.clave),
      id,
    ]);
    // Cambiar la clave cierra las sesiones abiertas: es lo que uno espera
    // cuando la cambia justamente porque se la robaron.
    cerrarSesionesDe(id);
  }

  run(
    `UPDATE users SET name = ?, role = ?, active = ?, updated_at = datetime('now') WHERE id = ?`,
    [
      cambio.name?.trim() ?? actual.name,
      cambio.role ?? actual.role,
      toDbBool(cambio.active ?? actual.active),
      id,
    ],
  );

  if (cambio.active === false) cerrarSesionesDe(id);
  return obtenerUsuario(id)!;
}

const ultimoDueño = (id: string): boolean =>
  (get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'dueño' AND active = 1 AND id <> ?",
    [id],
  )?.n ?? 0) === 0;

export function eliminarUsuario(id: string): void {
  const usuario = obtenerUsuario(id);
  if (!usuario) throw notFound('Usuario');
  if (usuario.role === 'dueño' && ultimoDueño(id)) {
    throw conflict('Es el único dueño activo: primero designá a otro');
  }
  run('DELETE FROM users WHERE id = ?', [id]);
}

// ── Sesiones ────────────────────────────────────────────────────────────────

/** Cuanto dura una sesion sin volver a pedir la clave. */
export const DIAS_DE_SESION = 30;

const hashDeToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface Sesion {
  token: string;
  usuario: Usuario;
}

/** Verifica usuario y clave. Devuelve null si algo no coincide, sin decir qué. */
export async function autenticar(usuario: string, clave: string): Promise<Usuario | null> {
  const row = get<UsuarioRow>('SELECT * FROM users WHERE username = ?', [normalizarUsuario(usuario)]);

  // Se verifica igual contra un hash falso cuando el usuario no existe, para
  // que el tiempo de respuesta no revele qué nombres están dados de alta.
  const guardado = row?.password_hash ?? `${'0'.repeat(32)}$${'0'.repeat(128)}`;
  const coincide = await claveCorrecta(clave, guardado);

  if (!row || !coincide || row.active !== 1) return null;
  return mapUsuario(row);
}

export function abrirSesion(usuario: Usuario, userAgent = ''): string {
  const token = randomBytes(32).toString('base64url');
  run(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES (?, ?, datetime('now', ?), ?)`,
    [hashDeToken(token), usuario.id, `+${DIAS_DE_SESION} days`, userAgent.slice(0, 200)],
  );
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [usuario.id]);
  limpiarSesionesVencidas();
  return token;
}

export function usuarioDeSesion(token: string): Usuario | null {
  const fila = get<{ user_id: string }>(
    "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')",
    [hashDeToken(token)],
  );
  if (!fila) return null;

  const usuario = obtenerUsuario(fila.user_id);
  if (!usuario || !usuario.active) return null;

  run("UPDATE sessions SET last_seen_at = datetime('now') WHERE token_hash = ?", [hashDeToken(token)]);
  return usuario;
}

export const cerrarSesion = (token: string): void => {
  run('DELETE FROM sessions WHERE token_hash = ?', [hashDeToken(token)]);
};

export const cerrarSesionesDe = (userId: string): void => {
  run('DELETE FROM sessions WHERE user_id = ?', [userId]);
};

export const limpiarSesionesVencidas = (): void => {
  run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
};

// ── Registro de cambios ─────────────────────────────────────────────────────

export interface EntradaAuditoria {
  user_id: string | null;
  user_name: string;
  role: string;
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
}

export function registrar(entrada: EntradaAuditoria): void {
  run(
    `INSERT INTO audit_log (id, user_id, user_name, role, action, target, detail, ip)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      newId('aud'),
      entrada.user_id,
      entrada.user_name,
      entrada.role,
      entrada.action,
      entrada.target ?? '',
      entrada.detail ?? '',
      entrada.ip ?? '',
    ],
  );
}

export interface FiltroDeAuditoria {
  /** Nombre o usuario de quien hizo el cambio. Coincidencia parcial. */
  quien?: string;
  /** Texto libre sobre la acción o sobre qué se tocó. */
  texto?: string;
  /** Desde y hasta, como AAAA-MM-DD. `hasta` incluye el día entero. */
  desde_fecha?: string;
  hasta_fecha?: string;
}

export interface FilaDeAuditoria {
  user_name: string;
  role: string;
  action: string;
  target: string;
  detail: string;
  created_at: string;
}

/**
 * El registro de cambios, filtrable.
 *
 * Una lista sola alcanza la primera semana. Después la pregunta real es
 * "¿quién tocó el precio de la pizza el jueves?", y para eso hace falta
 * buscar por persona y por fecha.
 */
export function listarAuditoria(
  opciones: OpcionesDePagina = { limite: 200, desde: 0 },
  filtro: FiltroDeAuditoria = {},
): Pagina<FilaDeAuditoria> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filtro.quien?.trim()) {
    where.push('user_name LIKE ?');
    params.push(`%${filtro.quien.trim()}%`);
  }
  if (filtro.texto?.trim()) {
    where.push('(action LIKE ? OR target LIKE ? OR detail LIKE ?)');
    const q = `%${filtro.texto.trim()}%`;
    params.push(q, q, q);
  }
  if (filtro.desde_fecha) {
    where.push('created_at >= ?');
    params.push(`${filtro.desde_fecha} 00:00:00`);
  }
  if (filtro.hasta_fecha) {
    // El "hasta" de una persona incluye ese día entero, no las 00:00.
    where.push('created_at <= ?');
    params.push(`${filtro.hasta_fecha} 23:59:59`);
  }

  return consultarPagina<FilaDeAuditoria>(
    'user_name, role, action, target, detail, created_at',
    `FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`,
    params,
    opciones,
  );
}

/** Quiénes aparecen en el registro, para llenar el selector del filtro. */
export const quienesFiguranEnLaAuditoria = (): string[] =>
  all<{ user_name: string }>(
    'SELECT DISTINCT user_name FROM audit_log ORDER BY user_name',
  ).map((f) => f.user_name);
