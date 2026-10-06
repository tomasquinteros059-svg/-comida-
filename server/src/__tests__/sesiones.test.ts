import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('sesiones');
process.env.ADMIN_TOKEN = 'token-maestro-de-prueba-32-bytes!';
process.env.NODE_ENV = 'production';
process.env.LOGIN_RATE_MAX = '500';

/**
 * Echar a alguien.
 *
 * El botón "cerrar sesiones" es el que se aprieta cuando alguien se va del
 * local, o cuando se le pierde el teléfono con el panel abierto. Si no
 * invalida de verdad lo que ya estaba abierto, el que se fue sigue entrando y
 * nadie se entera: el panel muestra el botón, dice que sí, y no pasa nada.
 *
 * No tenía ninguna prueba. La ruta tampoco.
 */

const TOKEN = 'token-maestro-de-prueba-32-bytes!';

const { closeDb, run } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const users = await import('../domain/users.js');

let base: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
});

beforeEach(() => {
  run('DELETE FROM sessions');
  run('DELETE FROM users');
  run('DELETE FROM audit_log');
});

const pedir = (ruta: string, init: RequestInit = {}) =>
  fetch(base + ruta, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const conToken = (ruta: string, init: RequestInit = {}) =>
  pedir(ruta, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${TOKEN}` } });

const cookieDe = (res: Response): string => {
  const valor = (res.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(valor?.startsWith('comeia_sesion='), 'no vino la cookie');
  return valor!;
};

/** Da de alta a alguien, lo hace entrar DOS veces y devuelve las dos cookies. */
async function dosDispositivos(username: string, role: 'dueño' | 'encargado' | 'cocina' = 'cocina') {
  const usuario = await users.crearUsuario({ name: username, username, clave: 'clave-de-prueba', role });
  const cookies: string[] = [];
  for (const agente of ['el teléfono', 'la compu del local']) {
    const res = await pedir('/api/auth/login', {
      method: 'POST',
      headers: { 'user-agent': agente },
      body: JSON.stringify({ usuario: username, clave: 'clave-de-prueba' }),
    });
    assert.equal(res.status, 200, `no pudo entrar desde ${agente}`);
    cookies.push(cookieDe(res));
  }
  return { usuario, cookies };
}

/**
 * Si esa cookie sigue sirviendo.
 *
 * Se mira el campo y no el código: /api/auth/me es pública a propósito —el
 * panel la llama antes de tener sesión— así que siempre contesta 200. Mirar
 * el 200 da "sigue adentro" siempre, y la prueba pasa sin probar nada.
 */
const sigueAdentro = async (cookie: string): Promise<boolean> => {
  const res = await pedir('/api/auth/me', { headers: { cookie } });
  assert.equal(res.status, 200, 'esta ruta es pública: tiene que contestar siempre');
  return ((await res.json()) as { autenticado: boolean }).autenticado;
};

describe('cerrar las sesiones de alguien', () => {
  it('lo saca de TODOS los dispositivos, no solo del último', async () => {
    const { usuario, cookies } = await dosDispositivos('beto');
    assert.ok(await sigueAdentro(cookies[0]!), 'el teléfono tenía que estar adentro');
    assert.ok(await sigueAdentro(cookies[1]!), 'la compu tenía que estar adentro');

    const res = await conToken(`/api/usuarios/${usuario.id}/sesiones/cerrar`, { method: 'POST' });
    assert.equal(res.status, 200);

    // Las dos, no una: alguien que se va del local dejó el panel abierto en
    // más de un lado y de eso nadie se acuerda.
    assert.equal(await sigueAdentro(cookies[0]!), false, 'el teléfono siguió adentro');
    assert.equal(await sigueAdentro(cookies[1]!), false, 'la compu siguió adentro');
  });

  it('no toca a los demás', async () => {
    const { usuario } = await dosDispositivos('beto');
    const otra = await dosDispositivos('caro');

    await conToken(`/api/usuarios/${usuario.id}/sesiones/cerrar`, { method: 'POST' });

    assert.ok(await sigueAdentro(otra.cookies[0]!), 'le cerró la sesión al que no era');
  });

  it('no le cambia la clave: puede volver a entrar', async () => {
    // Es la diferencia con dar de baja. Sirve para el teléfono perdido: el
    // que lo encontró queda afuera, el dueño del teléfono vuelve a entrar.
    const { usuario } = await dosDispositivos('beto');
    await conToken(`/api/usuarios/${usuario.id}/sesiones/cerrar`, { method: 'POST' });

    const res = await pedir('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usuario: 'beto', clave: 'clave-de-prueba' }),
    });
    assert.equal(res.status, 200, 'la clave tenía que seguir sirviendo');
  });

  it('queda anotado en la bitácora, con el nombre de quien lo echó', async () => {
    const { usuario } = await dosDispositivos('beto');
    await conToken(`/api/usuarios/${usuario.id}/sesiones/cerrar`, { method: 'POST' });

    const bitacora = (await (await conToken('/api/usuarios/auditoria')).json()) as {
      items: Array<{ action: string; target: string }>;
    };
    const entrada = bitacora.items.find((e) => e.action === 'cierre de sesiones');
    assert.ok(entrada, 'no quedó anotado: es lo que se mira cuando alguien reclama');
    assert.equal(entrada.target, 'beto');
  });

  it('con un id que no existe contesta 404, no 200 en falso', async () => {
    const res = await conToken('/api/usuarios/no-existe/sesiones/cerrar', { method: 'POST' });
    assert.equal(res.status, 404);
  });

  it('la cocina no puede echar a nadie', async () => {
    const { usuario } = await dosDispositivos('beto');
    const cocina = await dosDispositivos('dani', 'cocina');

    const res = await pedir(`/api/usuarios/${usuario.id}/sesiones/cerrar`, {
      method: 'POST',
      headers: { cookie: cocina.cookies[0]! },
    });
    assert.ok(res.status === 401 || res.status === 403, `contestó ${res.status}`);
  });

  it('dar de baja a alguien también lo saca: no espera a que venza la sesión', async () => {
    // Una sesión dura 30 días. Dar de baja sin cerrar la sesión deja a alguien
    // dado de baja adentro durante un mes.
    const { usuario, cookies } = await dosDispositivos('beto');
    await conToken(`/api/usuarios/${usuario.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: false }),
    });
    assert.equal(await sigueAdentro(cookies[0]!), false);
  });
});
