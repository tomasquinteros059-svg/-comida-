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

describe('cambiarse la clave uno mismo', () => {
  it('cambia la clave y deja la sesión de este dispositivo abierta', async () => {
    const cookie = await entrarComo('cocina', 'cocinero');
    const res = await pedir('/api/auth/clave', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ actual: 'clave-de-prueba', nueva: 'la-clave-nueva-larga' }),
    });
    assert.equal(res.status, 200, await res.text());

    // La sesión vieja seguiría valiendo si no se abriera una nueva: el que
    // cambia su clave no puede quedar afuera por cambiarla.
    const nueva = res.headers.get('set-cookie') ?? '';
    assert.ok(nueva.startsWith('comeia_sesion='), 'tiene que venir una cookie nueva');
    const cookieNueva = nueva.split(';')[0]!;
    assert.equal((await pedir('/api/orders/kitchen', { headers: { cookie: cookieNueva } })).status, 200);

    // Y la clave vieja ya no entra.
    const conVieja = await pedir('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usuario: 'cocinero', clave: 'clave-de-prueba' }),
    });
    assert.equal(conVieja.status, 401);
    const conNueva = await pedir('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usuario: 'cocinero', clave: 'la-clave-nueva-larga' }),
    });
    assert.equal(conNueva.status, 200);
  });

  it('cierra las sesiones de los otros dispositivos', async () => {
    const enElCelular = await entrarComo('encargado', 'beto');
    const enLaCaja = await pedir('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usuario: 'beto', clave: 'clave-de-prueba' }),
    }).then((r) => (r.headers.get('set-cookie') ?? '').split(';')[0]!);

    await pedir('/api/auth/clave', {
      method: 'POST',
      headers: { cookie: enLaCaja },
      body: JSON.stringify({ actual: 'clave-de-prueba', nueva: 'otra-clave-bien-larga' }),
    });

    assert.equal(
      (await pedir('/api/dashboard', { headers: { cookie: enElCelular } })).status,
      401,
      'la sesión del otro dispositivo tiene que morir',
    );
  });

  it('pide la clave actual aunque la sesión esté abierta', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    const res = await pedir('/api/auth/clave', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ actual: 'no-es-esta', nueva: 'la-clave-nueva-larga' }),
    });
    assert.equal(res.status, 401, 'si no, el que encuentra una pantalla abierta se queda con la cuenta');
  });

  it('no acepta una clave nueva corta ni igual a la actual', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    const corta = await pedir('/api/auth/clave', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ actual: 'clave-de-prueba', nueva: 'corta' }),
    });
    assert.equal(corta.status, 400);

    const igual = await pedir('/api/auth/clave', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ actual: 'clave-de-prueba', nueva: 'clave-de-prueba' }),
    });
    assert.equal(igual.status, 400);
  });

  it('sin sesión no se puede', async () => {
    const res = await pedir('/api/auth/clave', {
      method: 'POST',
      body: JSON.stringify({ actual: 'clave-de-prueba', nueva: 'la-clave-nueva-larga' }),
    });
    assert.equal(res.status, 401);
  });

  it('con el token maestro explica por qué no, en vez de romperse', async () => {
    const res = await pedir('/api/auth/clave', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ actual: 'lo-que-sea', nueva: 'la-clave-nueva-larga' }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /token maestro/);
  });
});

describe('mensajes de validación', () => {
  it('salen en castellano y no en inglés', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    const res = await pedir('/api/menu/products', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(res.status, 400);
    const { issues } = await res.json();
    const textos = issues.map((i: { detalle: string }) => i.detalle).join(' | ');
    assert.ok(!/must contain|Required|Expected|String|Invalid/.test(textos), `salió en inglés: ${textos}`);
    assert.match(textos, /vacío|Falta/);
  });

  it('una opción inválida dice cuáles son las válidas', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    const { createIngredient } = await import('../domain/stock.js');
    const insumo = createIngredient({ name: 'Harina', unit: 'kg', stock_qty: 5 });
    const res = await pedir(`/api/stock/ingredients/${insumo.id}/movements`, {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ delta: 1, reason: 'lo-que-sea' }),
    });
    assert.equal(res.status, 400);
    const detalle = (await res.json()).issues[0].detalle;
    assert.match(detalle, /no es una opción válida/);
    assert.match(detalle, /merma/, 'tiene que listar las que sí valen');
  });

  it('un número donde va texto lo dice sin jerga', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    const res = await pedir('/api/menu/categories', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ name: 42 }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).issues[0].detalle, /texto/);
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
    const filas = users.listarAuditoria() as Array<{ user_name: string; action: string; target: string }>;
    assert.ok(filas.some((f) => f.action === 'ingreso' && f.user_name === 'ana'));
    // El registro lo lee el dueño del local: tiene que decir qué pasó, no la
    // ruta HTTP que se llamó.
    const alta = filas.find((f) => f.action.includes('categoría'));
    assert.ok(alta, `no quedó registrado el alta: ${JSON.stringify(filas.slice(0, 3))}`);
    assert.equal(alta!.action, 'dio de alta una categoría');
    assert.equal(alta!.target, 'Pizzas');
  });

  it('el registro nombra las cosas, no los identificadores', async () => {
    const cookie = await entrarComo('dueño', 'ana');
    const { createIngredient } = await import('../domain/stock.js');
    const insumo = createIngredient({ name: 'Mozzarella', unit: 'kg', stock_qty: 5 });
    await pedir(`/api/stock/ingredients/${insumo.id}/movements`, {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ delta: -2, reason: 'merma' }),
    });
    const fila = (users.listarAuditoria() as Array<{ action: string; target: string }>).find((f) =>
      f.action.includes('stock'),
    );
    assert.equal(fila?.action, 'ajustó el stock de un insumo');
    assert.equal(fila?.target, 'Mozzarella', 'tiene que decir Mozzarella, no ing_01M2...');
  });

  it('no anota lo que salió mal', async () => {
    const cookie = await entrarComo('cocina', 'cocinero');
    await pedir('/api/menu/categories', {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ name: 'Pizzas' }),
    });
    const filas = users.listarAuditoria() as Array<{ action: string }>;
    assert.ok(!filas.some((f) => f.action.includes('categoría')));
  });
});
