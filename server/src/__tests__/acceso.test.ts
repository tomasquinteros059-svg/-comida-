import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('acceso');
process.env.ADMIN_TOKEN = 'una-clave-larga-de-prueba-32-bytes';
process.env.NODE_ENV = 'production';

const { closeDb } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');

const TOKEN = 'una-clave-larga-de-prueba-32-bytes';
let base: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

before(async () => {
  const category = createCategory({ name: 'Empanadas' }).id;
  createProduct({ name: 'Empanada de carne', category_id: category, price_cents: 150_000 });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const dir = server.address() as { port: number };
  base = `http://127.0.0.1:${dir.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
});

const sinToken = (ruta: string, init?: RequestInit) => fetch(base + ruta, init);
const conToken = (ruta: string, init: RequestInit = {}) =>
  fetch(base + ruta, { ...init, headers: { ...init.headers, authorization: `Bearer ${TOKEN}` } });

/**
 * Lo que un desconocido puede tocar desde internet. El chat es publico porque
 * lo usa el cliente final; todo lo demas es del local, incluidas las
 * conversaciones, que traen lo que la gente escribio.
 */
describe('que queda expuesto sin credencial', () => {
  it('deja mandar un mensaje al chat', async () => {
    const res = await sinToken('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hola, quiero una empanada' }),
    });
    assert.equal(res.status, 200);
    const turno = await res.json();
    assert.ok(turno.conversation_id);
  });

  it('responde el estado y el motor', async () => {
    assert.equal((await sinToken('/api/health')).status, 200);
    assert.equal((await sinToken('/api/chat/engine')).status, 200);
  });

  it('NO deja listar las conversaciones', async () => {
    const res = await sinToken('/api/chat/conversations');
    assert.equal(res.status, 401, 'las conversaciones traen datos de los clientes');
  });

  it('NO deja leer una conversación ajena', async () => {
    const creada = await sinToken('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'soy Ana, mi telefono es 11-5555-1234' }),
    }).then((r) => r.json());

    const res = await sinToken(`/api/chat/conversations/${creada.conversation_id}`);
    assert.equal(res.status, 401, 'ni siquiera conociendo el id');
  });

  it('NO deja ver los mensajes marcados', async () => {
    assert.equal((await sinToken('/api/chat/flagged')).status, 401);
  });

  it('NO deja entrar al resto del panel', async () => {
    for (const ruta of ['/api/dashboard', '/api/orders', '/api/stock/ingredients', '/api/menu/products']) {
      assert.equal((await sinToken(ruta)).status, 401, `${ruta} tiene que pedir credencial`);
    }
  });

  it('con la credencial correcta, el local entra a todo', async () => {
    for (const ruta of ['/api/dashboard', '/api/chat/conversations', '/api/chat/flagged']) {
      assert.equal((await conToken(ruta)).status, 200, ruta);
    }
  });

  it('rechaza una credencial parecida pero distinta', async () => {
    const res = await fetch(base + '/api/dashboard', {
      headers: { authorization: `Bearer ${TOKEN.slice(0, -1)}X` },
    });
    assert.equal(res.status, 401);
  });
});

describe('cuerpos y parámetros mal formados', () => {
  it('un cuerpo roto es culpa de quien lo manda, no un error del servidor', async () => {
    const res = await sinToken('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{esto no es json',
    });
    assert.equal(res.status, 400, 'no puede ser 500');
  });

  it('corta un cuerpo enorme en la ruta pública', async () => {
    const res = await sinToken('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'a'.repeat(200_000) }),
    });
    assert.equal(res.status, 400);
  });

  it('rechaza una ventana de reporte inválida en vez de contestar vacío', async () => {
    const res = await conToken('/api/lagging?days=hola');
    assert.equal(res.status, 400, 'un informe vacío presentado como verdad es peor que un error');
  });

  it('rechaza una fecha con formato raro', async () => {
    assert.equal((await conToken('/api/sales?from=ayer')).status, 400);
  });

  it('acepta los valores razonables', async () => {
    assert.equal((await conToken('/api/lagging?days=7')).status, 200);
    assert.equal((await conToken('/api/sales?from=2026-01-01&to=2026-01-31')).status, 200);
  });
});
