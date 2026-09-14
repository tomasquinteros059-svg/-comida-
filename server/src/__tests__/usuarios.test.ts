import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('usuarios');
process.env.ADMIN_TOKEN = 'token-maestro-de-prueba-32-bytes!';
process.env.NODE_ENV = 'production';
// El limite de intentos se prueba aparte; si no, las pruebas se frenan a si mismas.
process.env.LOGIN_RATE_MAX = '500';

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

/** Saca el valor de la cookie de sesion de la respuesta del login. */
const cookieDe = (res: Response): string => {
  const set = res.headers.get('set-cookie') ?? '';
  const valor = set.split(';')[0];
  assert.ok(valor?.startsWith('comeia_sesion='), `no vino la cookie: ${set}`);
  return valor!;
};

/** Da de alta a alguien y devuelve su cookie ya iniciada. */
async function entrarComo(role: 'dueño' | 'encargado' | 'cocina', username: string) {
  await users.crearUsuario({ name: username, username, clave: 'clave-de-prueba', role });
  const res = await pedir('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ usuario: username, clave: 'clave-de-prueba' }),
  });
  assert.equal(res.status, 200, await res.text());
  return cookieDe(res);
}

describe('permisos por rol', () => {
  it('la cocina ve comandas y nada más', () => {
    assert.ok(users.puede('cocina', 'cocina'));
    for (const permiso of ['ventas', 'carta', 'stock', 'compras', 'bot', 'usuarios'] as const) {
      assert.equal(users.puede('cocina', permiso), false, `cocina no debería ver ${permiso}`);
    }
  });

  it('el encargado maneja el local pero no da de alta gente', () => {
    assert.ok(users.puede('encargado', 'ventas'));
    assert.ok(users.puede('encargado', 'compras'));
    assert.equal(users.puede('encargado', 'usuarios'), false);
  });

  it('el dueño puede todo', () => {
    for (const permiso of users.PERMISOS) assert.ok(users.puede('dueño', permiso));
  });
});

describe('claves', () => {
  it('no guarda la clave en claro', async () => {
    const creado = await users.crearUsuario({
      name: 'Ana', username: 'ana', clave: 'clave-de-prueba', role: 'dueño',
    });
    const fila = await import('../db/index.js').then((m) =>
      m.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [creado.id]),
    );
    assert.ok(fila);
    assert.ok(!fila!.password_hash.includes('clave-de-prueba'));
    assert.match(fila!.password_hash, /^[0-9a-f]{32}\$[0-9a-f]{128}$/);
  });

  it('rechaza claves cortas o de las de siempre', async () => {
    await assert.rejects(
      users.crearUsuario({ name: 'A', username: 'corta', clave: 'corta', role: 'cocina' }),
      /8 caracteres/,
    );
    await assert.rejects(
      users.crearUsuario({ name: 'A', username: 'facil', clave: '12345678', role: 'cocina' }),
      /adivinar/,
    );
  });

  it('no dice si el que falló fue el usuario o la clave', async () => {
    await users.crearUsuario({ name: 'Ana', username: 'ana', clave: 'clave-de-prueba', role: 'dueño' });
    const malaClave = await pedir('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usuario: 'ana', clave: 'otra-cosa-cualquiera' }),
    });
    const noExiste = await pedir('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usuario: 'nadie', clave: 'otra-cosa-cualquiera' }),
    });
    assert.equal(malaClave.status, 401);
    assert.equal(noExiste.status, 401);
    assert.deepEqual(await malaClave.json(), await noExiste.json());
  });

  it('cambiar la clave cierra las sesiones abiertas', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    assert.equal((await pedir('/api/dashboard', { headers: { cookie } })).status, 200);

    const yo = users.listarUsuarios()[0]!;
    await users.actualizarUsuario(yo.id, { clave: 'clave-nueva-larga' });
    assert.equal(
      (await pedir('/api/dashboard', { headers: { cookie } })).status,
      401,
      'la sesión vieja tiene que morir con la clave vieja',
    );
  });

  it('dar de baja a alguien lo saca en el acto', async () => {
    const cookie = await entrarComo('encargado', 'beto');
    const beto = users.listarUsuarios()[0]!;
    await users.actualizarUsuario(beto.id, { active: false });
    assert.equal((await pedir('/api/dashboard', { headers: { cookie } })).status, 401);
  });
});

describe('el local nunca se queda sin dueño', () => {
  it('no deja bajar de rol al único dueño', async () => {
    const dueño = await users.crearUsuario({
      name: 'Ana', username: 'ana', clave: 'clave-de-prueba', role: 'dueño',
    });
    await assert.rejects(users.actualizarUsuario(dueño.id, { role: 'cocina' }), /único dueño/);
    await assert.rejects(users.actualizarUsuario(dueño.id, { active: false }), /único dueño/);
    assert.throws(() => users.eliminarUsuario(dueño.id), /único dueño/);
  });

  it('con otro dueño activo, sí deja', async () => {
    const ana = await users.crearUsuario({
      name: 'Ana', username: 'ana', clave: 'clave-de-prueba', role: 'dueño',
    });
    await users.crearUsuario({ name: 'Beto', username: 'beto', clave: 'clave-de-prueba', role: 'dueño' });
    const cambiada = await users.actualizarUsuario(ana.id, { role: 'encargado' });
    assert.equal(cambiada.role, 'encargado');
  });
});

describe('qué alcanza cada rol por HTTP', () => {
  it('la cocina entra a comandas y rebota en el resto', async () => {
    const cookie = await entrarComo('cocina', 'cocinero');
    assert.equal((await pedir('/api/orders/kitchen', { headers: { cookie } })).status, 200);
    for (const ruta of ['/api/dashboard', '/api/menu/products', '/api/stock/ingredients', '/api/usuarios']) {
      const res = await pedir(ruta, { headers: { cookie } });
      assert.equal(res.status, 403, `${ruta} no es de la cocina (dio ${res.status})`);
    }
  });

  it('el encargado maneja todo menos los usuarios', async () => {
    const cookie = await entrarComo('encargado', 'encargada');
    for (const ruta of ['/api/dashboard', '/api/menu/products', '/api/stock/ingredients', '/api/orders/kitchen']) {
      assert.equal((await pedir(ruta, { headers: { cookie } })).status, 200, ruta);
    }
    assert.equal((await pedir('/api/usuarios', { headers: { cookie } })).status, 403);
  });

  it('el dueño entra a los usuarios', async () => {
    const cookie = await entrarComo('dueño', 'duenia');
    const res = await pedir('/api/usuarios', { headers: { cookie } });
    assert.equal(res.status, 200);
    const cuerpo = await res.json();
    assert.equal(cuerpo.usuarios.length, 1);
  });

  it('sin cookie ni token no entra nadie', async () => {
    assert.equal((await pedir('/api/dashboard')).status, 401);
  });

  it('una cookie inventada no sirve', async () => {
    const res = await pedir('/api/dashboard', { headers: { cookie: 'comeia_sesion=inventado' } });
    assert.equal(res.status, 401);
  });

  it('salir invalida la sesión', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    assert.equal((await pedir('/api/dashboard', { headers: { cookie } })).status, 200);
    await pedir('/api/auth/logout', { method: 'POST', headers: { cookie } });
    assert.equal((await pedir('/api/dashboard', { headers: { cookie } })).status, 401);
  });

  it('la cookie es HttpOnly para que un script no la pueda leer', async () => {
    await users.crearUsuario({ name: 'Ana', username: 'ana', clave: 'clave-de-prueba', role: 'dueño' });
    const res = await pedir('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usuario: 'ana', clave: 'clave-de-prueba' }),
    });
    const set = res.headers.get('set-cookie') ?? '';
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
  });
});

describe('primer arranque', () => {
  it('avisa que no hay usuarios todavía', async () => {
    const estado = await pedir('/api/auth/me').then((r) => r.json());
    assert.equal(estado.sinUsuarios, true);
    assert.equal(estado.autenticado, false);
  });

  it('el alta del primer dueño necesita el token de instalación', async () => {
    const sinToken = await pedir('/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ana', usuario: 'ana', clave: 'clave-de-prueba' }),
    });
    assert.equal(sinToken.status, 401, 'si no, el primero que encuentra la URL se queda con el local');

    const res = await pedir('/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ana', usuario: 'ana', clave: 'clave-de-prueba', token: TOKEN }),
    });
    const cuerpo = await res.json();
    assert.equal(res.status, 200, JSON.stringify(cuerpo));
    assert.equal(cuerpo.usuario.role, 'dueño');
    assert.equal((await pedir('/api/dashboard', { headers: { cookie: cookieDe(res) } })).status, 200);
  });

  it('no se puede usar dos veces', async () => {
    await users.crearUsuario({ name: 'Ana', username: 'ana', clave: 'clave-de-prueba', role: 'dueño' });
    const res = await pedir('/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ name: 'Otro', usuario: 'otro', clave: 'clave-de-prueba', token: TOKEN }),
    });
    assert.equal(res.status, 409);
  });
});

describe('el token maestro sigue sirviendo de llave de repuesto', () => {
  it('entra a todo aunque no haya ningún usuario', async () => {
    assert.equal((await conToken('/api/dashboard')).status, 200);
    assert.equal((await conToken('/api/usuarios')).status, 200);
  });
});

describe('registro de cambios', () => {
  it('anota quién tocó qué', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    await pedir('/api/menu/categories', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ name: 'Pizzas' }),
    });
    const filas = users.listarAuditoria() as Array<{ user_name: string; action: string }>;
    assert.ok(filas.some((f) => f.action === 'ingreso' && f.user_name === 'ana'));
    assert.ok(
      filas.some((f) => f.action.includes('POST') && f.action.includes('/menu/categories')),
      `no quedó registrado el alta: ${JSON.stringify(filas.slice(0, 3))}`,
    );
  });

  it('no anota lo que salió mal', async () => {
    const cookie = await entrarComo('cocina', 'cocinero');
    await pedir('/api/menu/categories', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ name: 'Pizzas' }),
    });
    const filas = users.listarAuditoria() as Array<{ action: string }>;
    assert.ok(!filas.some((f) => f.action.includes('/menu/categories')));
  });
});
