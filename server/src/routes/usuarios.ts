import { Router } from 'express';
import { z } from 'zod';
import { HttpError, route } from '../lib/http.js';
import {
  ROLES,
  actualizarUsuario,
  cerrarSesionesDe,
  crearUsuario,
  eliminarUsuario,
  listarAuditoria,
  listarUsuarios,
  obtenerUsuario,
  permisosDe,
  PERMISOS,
} from '../domain/users.js';
import { registrar } from '../domain/users.js';

export const usuariosRouter = Router();

const rol = z.enum(ROLES);

usuariosRouter.get(
  '/',
  route(() => ({
    usuarios: listarUsuarios(),
    roles: ROLES.map((r) => ({ rol: r, permisos: permisosDe(r) })),
    permisos: PERMISOS,
  })),
);

const altaBody = z.object({
  name: z.string().min(1).max(80),
  usuario: z.string().min(3).max(80),
  clave: z.string().min(8).max(200),
  role: rol,
});

usuariosRouter.post(
  '/',
  route(async (req) => {
    const body = altaBody.parse(req.body);
    const creado = await crearUsuario({
      name: body.name,
      username: body.usuario,
      clave: body.clave,
      role: body.role,
    });
    registrar({
      user_id: req.actor?.id ?? null,
      user_name: req.actor?.name ?? 'sistema',
      role: req.actor?.role ?? '',
      action: 'alta de usuario',
      target: creado.username,
      detail: `rol ${creado.role}`,
      ip: req.ip ?? '',
    });
    return creado;
  }),
);

const cambioBody = z.object({
  name: z.string().min(1).max(80).optional(),
  role: rol.optional(),
  active: z.boolean().optional(),
  clave: z.string().min(8).max(200).optional(),
});

usuariosRouter.patch(
  '/:id',
  route(async (req) => {
    const id = req.params.id!;
    const cambio = cambioBody.parse(req.body);

    // Nadie se baja ni se cambia el rol a si mismo: el error mas caro de esta
    // pantalla es quedarse afuera con un clic.
    if (req.actor?.id === id && (cambio.active === false || (cambio.role && cambio.role !== req.actor.role))) {
      throw new HttpError(409, 'No podés cambiarte el rol ni darte de baja a vos mismo');
    }

    const actualizado = await actualizarUsuario(id, cambio);
    const que = [
      cambio.name !== undefined ? 'nombre' : null,
      cambio.role !== undefined ? `rol ${cambio.role}` : null,
      cambio.active !== undefined ? (cambio.active ? 'reactivado' : 'dado de baja') : null,
      cambio.clave !== undefined ? 'clave nueva' : null,
    ].filter(Boolean);
    registrar({
      user_id: req.actor?.id ?? null,
      user_name: req.actor?.name ?? 'sistema',
      role: req.actor?.role ?? '',
      action: 'cambio de usuario',
      target: actualizado.username,
      detail: que.join(', '),
      ip: req.ip ?? '',
    });
    return actualizado;
  }),
);

usuariosRouter.delete(
  '/:id',
  route((req) => {
    const id = req.params.id!;
    if (req.actor?.id === id) throw new HttpError(409, 'No podés borrarte a vos mismo');
    const usuario = obtenerUsuario(id);
    eliminarUsuario(id);
    registrar({
      user_id: req.actor?.id ?? null,
      user_name: req.actor?.name ?? 'sistema',
      role: req.actor?.role ?? '',
      action: 'baja de usuario',
      target: usuario?.username ?? id,
      ip: req.ip ?? '',
    });
    return { ok: true };
  }),
);

/** Cerrar todas las sesiones de alguien, sin tocarle la clave. */
usuariosRouter.post(
  '/:id/sesiones/cerrar',
  route((req) => {
    const id = req.params.id!;
    const usuario = obtenerUsuario(id);
    if (!usuario) throw new HttpError(404, 'Usuario no encontrado');
    cerrarSesionesDe(id);
    registrar({
      user_id: req.actor?.id ?? null,
      user_name: req.actor?.name ?? 'sistema',
      role: req.actor?.role ?? '',
      action: 'cierre de sesiones',
      target: usuario.username,
      ip: req.ip ?? '',
    });
    return { ok: true };
  }),
);

usuariosRouter.get(
  '/auditoria',
  route((req) => listarAuditoria(Number(req.query.limite ?? 200) || 200)),
);
