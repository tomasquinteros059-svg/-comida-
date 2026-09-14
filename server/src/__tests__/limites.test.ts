import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('limites');
process.env.ADMIN_TOKEN = 'token-maestro-de-prueba-32-bytes!';
process.env.NODE_ENV = 'production';
// Chico a proposito: lo que se prueba aca es JUSTAMENTE que el limite corte, y
// sobre todo a quien deja afuera cuando corta.
process.env.LOGIN_RATE_MAX = '3';

const { closeDb } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { crearUsuario } = await import('../domain/users.js');

let base: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

before(async () => {
  await crearUsuario({ name: 'Ana', username: 'ana', clave: 'clave-de-prueba', role: 'dueño' });
  await crearUsuario({ name: 'Beto', username: 'beto', clave: 'clave-de-prueba', role: 'encargado' });
  await crearUsuario({ name: 'Caro', username: 'caro', clave: 'clave-de-prueba', role: 'cocina' });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
});

const pedir = (ruta: string, init: RequestInit = {}) =>
  fetch(base + ruta, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });

const entrar = async (usuario: string, clave = 'clave-de-prueba') => {
  const res = await pedir('/api/auth/login', { method: 'POST', body: JSON.stringify({ usuario, clave }) });
  assert.equal(res.status, 200, `no pudo entrar ${usuario}: ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
};

/**
 * En un local todos salen por el mismo router. Un limite contado por conexion
 * hace que el que se equivoca tecleando deje afuera a todo el turno, justo en
 * el cambio de turno que es cuando entran todos juntos.
 */
describe('los límites de intentos no castigan a los compañeros', () => {
  it('el que se equivoca al entrar no bloquea a los demás', async () => {
    let bloqueado = false;
    for (let i = 0; i < 8; i++) {
      const res = await pedir('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ usuario: 'caro', clave: `mal-${i}` }),
      });
      if (res.status === 429) { bloqueado = true; break; }
    }
    assert.ok(bloqueado, 'tiene que frenar al que prueba claves');

    const otro = await pedir('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usuario: 'beto', clave: 'clave-de-prueba' }),
    });
    assert.equal(otro.status, 200, 'el de al lado, con su clave correcta, tiene que entrar igual');
  });

  it('el que se equivoca cambiando su clave no bloquea al que cambia la suya', async () => {
    const deAna = await entrar('ana');
    const deBeto = await entrar('beto');

    let bloqueado = false;
    for (let i = 0; i < 8; i++) {
      const res = await pedir('/api/auth/clave', {
        method: 'POST',
        headers: { cookie: deAna },
        body: JSON.stringify({ actual: `mal-${i}`, nueva: 'una-clave-nueva-larga' }),
      });
      if (res.status === 429) { bloqueado = true; break; }
    }
    assert.ok(bloqueado, 'tiene que frenar al que insiste');

    const otro = await pedir('/api/auth/clave', {
      method: 'POST',
      headers: { cookie: deBeto },
      body: JSON.stringify({ actual: 'clave-de-prueba', nueva: 'la-clave-del-encargado' }),
    });
    assert.equal(otro.status, 200, 'misma IP, otra persona: tiene que poder');
  });

  it('pero sigue frenando al que prueba nombres de a montones', async () => {
    let bloqueado = false;
    for (let i = 0; i < 60; i++) {
      const res = await pedir('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ usuario: `inventado-${i}`, clave: 'lo-que-sea' }),
      });
      if (res.status === 429) { bloqueado = true; break; }
    }
    assert.ok(bloqueado, 'el techo por conexión tiene que cortar el barrido de usuarios');
  });
});
