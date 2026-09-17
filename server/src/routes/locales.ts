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
  SLUG_POR_DEFECTO,
} from '../db/locales.js';
import { HttpError } from '../lib/http.js';

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
      .object({
        nombre: z.string().min(2).max(80).optional(),
        hosts,
        activo: z.boolean().optional(),
        // El identificador del numero de WhatsApp de este local. Son digitos y
        // nada mas: si alguien pega el telefono en vez del identificador, que
        // lo diga aca y no cuando llegue el primer mensaje.
        whatsapp_id: z
          .string()
          .max(40)
          .regex(/^[0-9]*$/, 'El identificador del número son solo dígitos')
          .optional(),
      })
      .parse(req.body ?? {});

    // Desactivar el principal dejaria la instalacion sin donde atender, y ahi
    // ni siquiera se puede entrar al panel para volver atras.
    if (req.params.slug === SLUG_POR_DEFECTO && body.activo === false) {
      throw new HttpError(409, 'El local principal no se puede desactivar: quedarías sin panel');
    }
    return actualizarLocal(req.params.slug!, body);
  }),
);

localesRouter.get(
  '/:slug',
  route((req) => obtenerLocal(req.params.slug!) ?? Promise.reject(new Error('No existe ese local'))),
);
