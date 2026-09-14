import { Router } from 'express';
import { z } from 'zod';
import { HttpError, route } from '../lib/http.js';
import { rateLimit } from '../lib/rateLimit.js';
import {
  autenticar,
  abrirSesion,
  cerrarSesion,
  contarUsuarios,
  crearUsuario,
  actualizarUsuario,
  obtenerUsuario,
  permisosDe,
  registrar,
} from '../domain/users.js';
import {
  borrarCookieDeSesion,
  leerCookie,
  mismoToken,
  ponerCookieDeSesion,
  resolverActor,
  COOKIE_SESION,
} from '../lib/auth.js';
import { config } from '../config.js';

/** Entrar, salir y saber quien soy. Es lo unico que puede pasar sin sesion. */
export const authRouter = Router();

/**
 * Probar claves es barato para quien ataca y caro para el local, pero el
 * limite se cuenta por usuario y no solo por IP: en un local todos salen por
 * el mismo router, y con un limite por IP el pibe nuevo que se equivoca cuatro
 * veces deja afuera a todo el turno.
 */
const limitePorUsuario = rateLimit({
  windowMs: 60_000,
  max: config.loginRateMax,
  key: (req) => {
    const usuario = typeof req.body?.usuario === 'string' ? req.body.usuario.toLowerCase() : '';
    return `${req.ip ?? 'desconocido'}|${usuario}`;
  },
  message: 'Demasiados intentos con ese usuario. Esperá un minuto.',
});

/**
 * Techo por IP, mucho mas alto. No esta para frenar a quien se equivoca
 * escribiendo sino a quien prueba nombres de usuario de a cientos.
 */
const limitePorIp = rateLimit({
  windowMs: 60_000,
  max: config.loginRateMax * 8,
  message: 'Demasiados intentos desde esta conexión. Esperá un minuto.',
});

const limiteDeIngreso = [limitePorIp, limitePorUsuario];

const ingresoBody = z.object({
  usuario: z.string().min(1, 'Falta el usuario').max(80),
  clave: z.string().min(1, 'Falta la clave').max(200),
});

authRouter.post(
  '/login',
  ...limiteDeIngreso,
  route(async (req, res) => {
    const { usuario, clave } = ingresoBody.parse(req.body);
    const encontrado = await autenticar(usuario, clave);

    // Un solo mensaje para usuario inexistente, clave mala y usuario dado de
    // baja: decir cual de los tres es regalarle medio trabajo al que prueba.
    if (!encontrado) throw new HttpError(401, 'Usuario o clave incorrectos');

    const token = abrirSesion(encontrado, req.header('user-agent') ?? '');
    ponerCookieDeSesion(res, token);
    registrar({
      user_id: encontrado.id,
      user_name: encontrado.name,
      role: encontrado.role,
      action: 'ingreso',
      ip: req.ip ?? '',
    });
    return { usuario: encontrado, permisos: permisosDe(encontrado.role) };
  }),
);

authRouter.post(
  '/logout',
  route((req, res) => {
    const token = leerCookie(req, COOKIE_SESION);
    if (token) cerrarSesion(token);
    borrarCookieDeSesion(res);
    return { ok: true };
  }),
);

/**
 * Con que arranca el panel: si hay que crear el primer dueño, si hay que
 * pedir la clave, o quien esta adentro. Es publica a proposito —el panel la
 * llama antes de tener sesion— y por eso no devuelve nada mas que eso.
 */
authRouter.get(
  '/me',
  route((req) => {
    const actor = resolverActor(req);
    const sinUsuarios = contarUsuarios() === 0;
    if (!actor) return { autenticado: false, sinUsuarios, conToken: Boolean(config.adminToken) };
    return {
      autenticado: true,
      sinUsuarios,
      conToken: Boolean(config.adminToken),
      usuario: { id: actor.id, name: actor.name, role: actor.role, viaToken: actor.viaToken },
      permisos: actor.permisos,
    };
  }),
);

const bootstrapBody = z.object({
  name: z.string().min(1).max(80),
  usuario: z.string().min(3).max(80),
  clave: z.string().min(8).max(200),
  token: z.string().optional(),
});

/**
 * Alta del primer dueño. Solo funciona con la base sin usuarios, y ademas
 * pide el ADMIN_TOKEN cuando esta configurado: si no, el primero que
 * encuentra el panel recien instalado se queda con el local.
 */
authRouter.post(
  '/bootstrap',
  ...limiteDeIngreso,
  route(async (req, res) => {
    const body = bootstrapBody.parse(req.body);
    if (contarUsuarios() > 0) throw new HttpError(409, 'El local ya tiene usuarios dados de alta');

    if (config.adminToken) {
      const header = req.header('x-admin-token') ?? undefined;
      if (!mismoToken(body.token, config.adminToken) && !mismoToken(header, config.adminToken)) {
        throw new HttpError(401, 'Falta el token de instalación');
      }
    }

    const dueño = await crearUsuario({
      name: body.name,
      username: body.usuario,
      clave: body.clave,
      role: 'dueño',
    });
    const token = abrirSesion(dueño, req.header('user-agent') ?? '');
    ponerCookieDeSesion(res, token);
    registrar({
      user_id: dueño.id,
      user_name: dueño.name,
      role: dueño.role,
      action: 'alta del primer dueño',
      ip: req.ip ?? '',
    });
    return { usuario: dueño, permisos: permisosDe(dueño.role) };
  }),
);

const cambioDeClaveBody = z.object({
  actual: z.string().min(1, 'Poné tu clave actual'),
  nueva: z.string().min(8, 'La clave nueva tiene que tener al menos 8 caracteres').max(200),
});

/**
 * Cambiarse la clave uno mismo. Antes solo podía hacerlo el dueño desde
 * Usuarios, así que el que se la olvidaba un domingo a la noche no entraba
 * hasta que apareciera el dueño.
 *
 * Pide la clave actual aunque la sesión ya esté abierta: si no, alguien que
 * encuentra una pantalla sin bloquear se queda con la cuenta.
 */
/**
 * Se cuenta por persona, no por conexion: en un local todos salen por el mismo
 * router, y con un limite por IP el que se equivoca tecleando su clave actual
 * deja a sus compañeros sin poder cambiar la suya.
 */
const limiteDeCambio = rateLimit({
  windowMs: 60_000,
  max: config.loginRateMax,
  key: (req) => resolverActor(req)?.id ?? req.ip ?? 'desconocido',
  message: 'Demasiados intentos. Esperá un minuto.',
});

authRouter.post(
  '/clave',
  limiteDeCambio,
  route(async (req, res) => {
    const actor = resolverActor(req);
    if (!actor) throw new HttpError(401, 'Necesitás iniciar sesión');
    if (!actor.id) {
      throw new HttpError(
        409,
        'Entraste con el token maestro, que no es un usuario. Para cambiar una clave, entrá con tu usuario o usá la pantalla de Usuarios.',
      );
    }

    const { actual, nueva } = cambioDeClaveBody.parse(req.body);
    const usuario = obtenerUsuario(actor.id);
    if (!usuario) throw new HttpError(401, 'Necesitás iniciar sesión');

    if (!(await autenticar(usuario.username, actual))) {
      throw new HttpError(401, 'La clave actual no es esa');
    }
    if (actual === nueva) throw new HttpError(400, 'La clave nueva tiene que ser distinta de la actual');

    // actualizarUsuario cierra todas las sesiones al cambiar la clave, la de
    // este pedido incluida: se abre una nueva para no echar a quien la cambió.
    await actualizarUsuario(usuario.id, { clave: nueva });
    const token = abrirSesion(usuario, req.header('user-agent') ?? '');
    ponerCookieDeSesion(res, token);

    registrar({
      user_id: usuario.id,
      user_name: usuario.name,
      role: usuario.role,
      action: 'se cambió la clave',
      ip: req.ip ?? '',
    });
    return { ok: true };
  }),
);
