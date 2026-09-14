import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('locales');
process.env.ADMIN_TOKEN = 'token-maestro-de-prueba-32-bytes!';
process.env.NODE_ENV = 'production';

const TOKEN = 'token-maestro-de-prueba-32-bytes!';

const { closeDb } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const locales = await import('../db/locales.js');
const { createCategory, createProduct, listProducts } = await import('../domain/menu.js');
const { createOrder, contarOrdenes } = await import('../domain/orders.js');
const users = await import('../domain/users.js');

let base: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

before(async () => {
  locales.crearLocal({ nombre: 'La Esquina', slug: 'esquina', hosts: ['laesquina.test'] });
  locales.crearLocal({ nombre: 'Don José', slug: 'donjose', hosts: ['donjose.test'] });

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
});

const pedir = (ruta: string, local: string, init: RequestInit = {}) =>
  fetch(base + ruta, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'x-local': local,
      ...(init.headers ?? {}),
    },
  });

describe('cada local tiene su propia base', () => {
  it('son archivos distintos, no una columna en la misma tabla', () => {
    const a = locales.rutaDe('esquina');
    const b = locales.rutaDe('donjose');
    assert.notEqual(a, b);
    assert.ok(fs.existsSync(a), 'la base de La Esquina tiene que existir');
    assert.ok(fs.existsSync(b), 'la de Don José también');
  });

  it('la carta de uno no aparece en el otro', () => {
    locales.enLocal('esquina', () => {
      const cat = createCategory({ name: 'Pizzas' }).id;
      createProduct({ name: 'Pizza de La Esquina', category_id: cat, price_cents: 1_100_000 });
    });
    locales.enLocal('donjose', () => {
      const cat = createCategory({ name: 'Milanesas' }).id;
      createProduct({ name: 'Milanesa de Don José', category_id: cat, price_cents: 1_800_000 });
    });

    const enEsquina = locales.enLocal('esquina', () => listProducts({ includeUnavailable: true }).map((p) => p.name));
    const enDonJose = locales.enLocal('donjose', () => listProducts({ includeUnavailable: true }).map((p) => p.name));

    assert.deepEqual(enEsquina, ['Pizza de La Esquina']);
    assert.deepEqual(enDonJose, ['Milanesa de Don José']);
  });

  it('los pedidos de uno no se cuentan en el otro', () => {
    const producto = locales.enLocal('esquina', () =>
      listProducts({ includeUnavailable: true })[0]!.id,
    );
    locales.enLocal('esquina', () => {
      createOrder({ lines: [{ product_id: producto, qty: 2 }], confirm: true });
      createOrder({ lines: [{ product_id: producto, qty: 1 }], confirm: true });
    });

    assert.equal(locales.enLocal('esquina', () => contarOrdenes()), 2);
    assert.equal(locales.enLocal('donjose', () => contarOrdenes()), 0, 'la facturación no se mezcla');
  });

  it('los usuarios de uno no entran al otro', async () => {
    await locales.enLocal('esquina', () =>
      users.crearUsuario({ name: 'Ana', username: 'ana', clave: 'clave-de-prueba', role: 'dueño' }),
    );

    const enEsquina = locales.enLocal('esquina', () => users.listarUsuarios().map((u) => u.username));
    const enDonJose = locales.enLocal('donjose', () => users.listarUsuarios().map((u) => u.username));

    assert.deepEqual(enEsquina, ['ana']);
    assert.deepEqual(enDonJose, [], 'la clave de un local no abre el otro');
  });
});

describe('a qué local entra cada pedido', () => {
  it('lo decide el dominio', () => {
    assert.equal(locales.localPorHost('laesquina.test')?.slug, 'esquina');
    assert.equal(locales.localPorHost('donjose.test')?.slug, 'donjose');
    assert.equal(locales.localPorHost('DONJOSE.TEST')?.slug, 'donjose', 'sin importar mayúsculas');
    assert.equal(locales.localPorHost('donjose.test:3000')?.slug, 'donjose', 'ni el puerto');
  });

  it('un dominio que no está cargado no entra a ningún lado', async () => {
    const res = await fetch(`${base}/api/menu/products`, {
      headers: { authorization: `Bearer ${TOKEN}`, host: 'nadie.test' },
    });
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /No hay ningún local/);
  });

  it('por HTTP, cada local ve solo lo suyo', async () => {
    const esquina = await pedir('/api/menu/products', 'esquina').then((r) => r.json());
    const donjose = await pedir('/api/menu/products', 'donjose').then((r) => r.json());

    const nombres = (d: unknown) => (Array.isArray(d) ? d : (d as { products?: unknown[] }).products ?? [])
      .map((p) => (p as { name: string }).name);

    assert.deepEqual(nombres(esquina), ['Pizza de La Esquina']);
    assert.deepEqual(nombres(donjose), ['Milanesa de Don José']);
  });

  it('la respuesta dice a qué local fue', async () => {
    const res = await pedir('/api/menu/products', 'donjose');
    assert.equal(res.headers.get('x-local'), 'donjose');
  });

  it('un local desactivado no atiende', async () => {
    locales.actualizarLocal('donjose', { activo: false });
    const res = await pedir('/api/menu/products', 'donjose');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /desactivado/);
    locales.actualizarLocal('donjose', { activo: true });
  });
});

describe('dar de alta locales', () => {
  it('el slug sale del nombre, sin acentos ni espacios', () => {
    assert.equal(locales.aSlug('Rotisería La Ñata'), 'roticeria-la-nata'.replace('c', 's'));
    assert.equal(locales.aSlug('  Don  José  '), 'don-jose');
  });

  it('no deja dos locales con el mismo nombre', () => {
    assert.throws(() => locales.crearLocal({ nombre: 'La Esquina', slug: 'esquina' }), /Ya hay un local/);
  });

  it('un dominio no puede llevar a dos locales', () => {
    assert.throws(
      () => locales.crearLocal({ nombre: 'Otro', slug: 'otro', hosts: ['laesquina.test'] }),
      /ya lleva al local/,
    );
  });

  it('tampoco al editar', () => {
    assert.throws(() => locales.actualizarLocal('donjose', { hosts: ['laesquina.test'] }), /ya lleva al local/);
  });

  it('crear un local deja su base lista para usar', () => {
    const nuevo = locales.crearLocal({ nombre: 'Tercero', slug: 'tercero' });
    assert.ok(fs.existsSync(locales.rutaDe(nuevo.slug)));
    // Se puede usar enseguida, sin ningún paso extra.
    locales.enLocal('tercero', () => {
      const cat = createCategory({ name: 'Algo' }).id;
      assert.ok(createProduct({ name: 'Producto', category_id: cat, price_cents: 100 }).id);
    });
  });
});

describe('las tareas de fondo pasan por todos', () => {
  it('porCadaLocal recorre los activos', () => {
    const vistos = locales.porCadaLocal((slug) => slug);
    const slugs = vistos.map((v) => v.resultado).sort();
    assert.deepEqual(slugs, ['donjose', 'esquina', 'tercero']);
  });

  it('cada vuelta corre con la base de su local', () => {
    const conteos = locales.porCadaLocal(() => contarOrdenes());
    const esquina = conteos.find((c) => c.slug === 'esquina');
    const donjose = conteos.find((c) => c.slug === 'donjose');
    assert.equal(esquina?.resultado, 2);
    assert.equal(donjose?.resultado, 0);
  });

  it('si uno falla, los demás siguen', () => {
    const resultados = locales.porCadaLocal((slug) => {
      if (slug === 'esquina') throw new Error('se rompió este');
      return 'ok';
    });
    assert.ok(resultados.find((r) => r.slug === 'esquina')?.error);
    assert.equal(resultados.filter((r) => r.resultado === 'ok').length, 2);
  });

  it('un local desactivado se saltea', () => {
    locales.actualizarLocal('tercero', { activo: false });
    const slugs = locales.porCadaLocal((s) => s).map((v) => v.slug);
    assert.ok(!slugs.includes('tercero'));
    locales.actualizarLocal('tercero', { activo: true });
  });
});

describe('los avisos en vivo no se cruzan', () => {
  it('lo que pasa en un local no le suena al otro', async () => {
    const { emit, subscribe, _resetListeners } = await import('../lib/events.js');
    _resetListeners();

    const enEsquina: string[] = [];
    const enDonJose: string[] = [];
    locales.enLocal('esquina', () => subscribe((e) => enEsquina.push(e.detail ?? '')));
    locales.enLocal('donjose', () => subscribe((e) => enDonJose.push(e.detail ?? '')));

    locales.enLocal('esquina', () => emit('pedido', 'pedido de La Esquina'));

    assert.deepEqual(enEsquina, ['pedido de La Esquina']);
    assert.deepEqual(enDonJose, [], 'el panel del otro local no puede parpadear por esto');
  });
});
