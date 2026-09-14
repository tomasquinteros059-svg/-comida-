import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import {
  actualizarLocal,
  crearLocal,
  hayVariosLocales,
  listarLocales,
  localActual,
  obtenerLocal,
  rutaDe,
} from '../db/locales.js';

/**
 * Los locales de esta instalacion.
 *
 * Es del dueño y nada mas: dar de alta un local es crear una base entera, y
 * cambiar un dominio manda los pedidos a otra cocina.
 */
export const localesRouter = Router();

const hosts = z
  .array(z.string().min(3).max(200))
  .max(10)
  .optional()
  .transform((v) => v?.map((h) => h.trim().toLowerCase()).filter(Boolean));

localesRouter.get(
  '/',
  route(() => ({
    locales: listarLocales().map((l) => ({ ...l, archivo: rutaDe(l.slug) })),
    actual: localActual(),
    varios: hayVariosLocales(),
  })),
);

localesRouter.post(
  '/',
  route((req) => {
    const body = z
      .object({ nombre: z.string().min(2).max(80), slug: z.string().max(40).optional(), hosts })
      .parse(req.body ?? {});
    return crearLocal(body);
  }),
);

localesRouter.patch(
  '/:slug',
  route((req) => {
    const body = z
      .object({ nombre: z.string().min(2).max(80).optional(), hosts, activo: z.boolean().optional() })
      .parse(req.body ?? {});
    return actualizarLocal(req.params.slug!, body);
  }),
);

localesRouter.get(
  '/:slug',
  route((req) => obtenerLocal(req.params.slug!) ?? Promise.reject(new Error('No existe ese local'))),
);
