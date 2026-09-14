import type { NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config, isProduction } from '../config.js';
import { HttpError } from './http.js';
import {
  DIAS_DE_SESION,
  permisosDe,
  usuarioDeSesion,
  type Permiso,
  type Rol,
  type Usuario,
} from '../domain/users.js';

export const COOKIE_SESION = 'comeia_sesion';

/**
 * Quien esta haciendo el pedido. Puede ser un usuario del local, el token
 * maestro (la llave de recuperacion que se guarda en el .env) o, solo en
 * desarrollo, nadie.
 */
export interface Actor {
  id: string | null;
  name: string;
  role: Rol;
  permisos: readonly Permiso[];
  /** true cuando entro con ADMIN_TOKEN y no con usuario y clave. */
  viaToken: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

const actorDeUsuario = (usuario: Usuario): Actor => ({
  id: usuario.id,
  name: usuario.name,
  role: usuario.role,
  permisos: permisosDe(usuario.role),
  viaToken: false,
});

const ACTOR_MAESTRO: Actor = {
  id: null,
  name: 'token maestro',
  role: 'dueño',
  permisos: permisosDe('dueño'),
  viaToken: true,
};

const ACTOR_ABIERTO: Actor = { ...ACTOR_MAESTRO, name: 'desarrollo' };

// ── Cookies ─────────────────────────────────────────────────────────────────

/**
 * Lee una cookie sin sumar cookie-parser. Es una linea con `nombre=valor`
 * separada por `; `, y necesitamos exactamente una.
 */
export function leerCookie(req: Request, nombre: string): string | undefined {
  const crudo = req.header('cookie');
  if (!crudo) return undefined;
  for (const parte of crudo.split(';')) {
    const igual = parte.indexOf('=');
    if (igual < 0) continue;
    if (parte.slice(0, igual).trim() !== nombre) continue;
    return decodeURIComponent(parte.slice(igual + 1).trim());
  }
  return undefined;
}

/**
 * La sesion viaja en una cookie HttpOnly: asi un script inyectado en el panel
 * no puede leerla, que es la diferencia con guardarla en localStorage.
 */
export function ponerCookieDeSesion(res: Response, token: string): void {
  res.cookie(COOKIE_SESION, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    maxAge: DIAS_DE_SESION * 24 * 60 * 60 * 1000,
  });
}

export function borrarCookieDeSesion(res: Response): void {
  res.clearCookie(COOKIE_SESION, { httpOnly: true, sameSite: 'lax', secure: isProduction(), path: '/' });
}

// ── Token maestro ───────────────────────────────────────────────────────────

/**
 * Compara sin que el tiempo delate cuantos caracteres acerto: con `===` la
 * comparacion corta en la primera diferencia y esa demora se puede medir.
 */
export function mismoToken(recibido: string | undefined, esperado: string): boolean {
  if (!recibido) return false;
  // El hash iguala los largos (timingSafeEqual los exige iguales) sin filtrar
  // cual era el largo correcto.
  const a = createHash('sha256').update(recibido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return timingSafeEqual(a, b);
}

const tokenDePedido = (req: Request): string | undefined => {
  const header = req.header('authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.header('x-admin-token') ?? undefined;
};

// ── Resolucion del actor ────────────────────────────────────────────────────

/**
 * Averigua quien pide, en orden: sesion iniciada, token maestro y —solo
 * cuando no hay ADMIN_TOKEN configurado, o sea en una notebook— acceso libre.
 * Devuelve undefined si nada aplica.
 */
export function resolverActor(req: Request, tokenExtra?: string): Actor | undefined {
  const cookie = leerCookie(req, COOKIE_SESION);
  if (cookie) {
    const usuario = usuarioDeSesion(cookie);
    if (usuario) return actorDeUsuario(usuario);
  }

  if (config.adminToken) {
    if (mismoToken(tokenDePedido(req), config.adminToken)) return ACTOR_MAESTRO;
    if (mismoToken(tokenExtra, config.adminToken)) return ACTOR_MAESTRO;
    return undefined;
  }

  // Sin ADMIN_TOKEN el servidor se niega a arrancar en produccion (ver
  // configProblems), asi que aca solo llega desarrollo.
  return ACTOR_ABIERTO;
}

/** Exige estar identificado. Deja el actor en req.actor. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const actor = resolverActor(req);
  if (!actor) return next(new HttpError(401, 'Necesitás iniciar sesión'));
  req.actor = actor;
  next();
}

/**
 * Igual que requireAuth pero acepta el token maestro por query string, que es
 * lo unico que puede hacer EventSource: no deja mandar cabeceras.
 */
export function requireAuthStream(req: Request, _res: Response, next: NextFunction): void {
  const extra = typeof req.query.token === 'string' ? req.query.token : undefined;
  const actor = resolverActor(req, extra);
  if (!actor) return next(new HttpError(401, 'Necesitás iniciar sesión'));
  req.actor = actor;
  next();
}

/**
 * Exige un permiso. Devuelve 403 y no 401 a proposito: el usuario esta bien
 * identificado, lo que falta es el permiso, y volver a pedirle la clave no lo
 * arregla.
 */
export function requirePermiso(permiso: Permiso) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const actor = req.actor;
    if (!actor) return next(new HttpError(401, 'Necesitás iniciar sesión'));
    if (!actor.permisos.includes(permiso)) {
      return next(new HttpError(403, `Tu rol (${actor.role}) no tiene acceso a ${permiso}`));
    }
    next();
  };
}
