import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('paginacion');

const { closeDb, run } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { createOrder, listOrders, contarOrdenes } = await import('../domain/orders.js');
const users = await import('../domain/users.js');

let producto: string;

before(async () => {
  const categoria = createCategory({ name: 'Empanadas' }).id;
  producto = createProduct({ name: 'Empanada de carne', category_id: categoria, price_cents: 150_000 }).id;

  // Doce pedidos: suficientes para que la primera página deje cosas afuera.
  for (let i = 0; i < 12; i++) {
    createOrder({ lines: [{ product_id: producto, qty: 1 }], channel: i < 5 ? 'chat' : 'mostrador' });
  }
});

after(() => closeDb());

describe('paginación de los listados', () => {
  it('trae la página pedida y dice cuántas hay en total', () => {
    const primera = listOrders({}, { limite: 5, desde: 0 });
    assert.equal(primera.items.length, 5);
    assert.equal(primera.total, 12, 'el total es cuántas hay, no cuántas vinieron');
    assert.equal(primera.hay_mas, true);
  });

  it('la última página avisa que no hay más', () => {
    const ultima = listOrders({}, { limite: 5, desde: 10 });
    assert.equal(ultima.items.length, 2);
    assert.equal(ultima.total, 12);
    assert.equal(ultima.hay_mas, false);
  });

  it('pasarse de largo devuelve vacío, no un error', () => {
    const lejos = listOrders({}, { limite: 5, desde: 500 });
    assert.equal(lejos.items.length, 0);
    assert.equal(lejos.total, 12);
    assert.equal(lejos.hay_mas, false);
  });

  it('las páginas no se pisan ni se saltean nada', () => {
    const vistos = new Set<string>();
    for (let desde = 0; desde < 12; desde += 4) {
      for (const o of listOrders({}, { limite: 4, desde }).items) vistos.add(o.id);
    }
    assert.equal(vistos.size, 12, 'recorriendo todas las páginas tienen que salir los 12');
  });

  it('el filtro se aplica antes de paginar', () => {
    const pagina = listOrders({ channel: 'chat' }, { limite: 3, desde: 0 });
    assert.equal(pagina.total, 5, 'el total tiene que ser el de los filtrados');
    assert.equal(pagina.items.length, 3);
    assert.ok(pagina.items.every((o) => o.channel === 'chat'));
  });

  it('contar no trae las filas', () => {
    assert.equal(contarOrdenes(), 12);
    assert.equal(contarOrdenes({ channel: 'chat' }), 5);
  });
});

describe('el registro de cambios se puede buscar', () => {
  before(() => {
    run('DELETE FROM audit_log');
    const anotar = (quien: string, accion: string, sobre: string, cuando: string) =>
      run(
        `INSERT INTO audit_log (id, user_id, user_name, role, action, target, detail, ip, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [`aud_${Math.random().toString(36).slice(2)}`, null, quien, 'dueño', accion, sobre, '', '', cuando],
      );
    anotar('Ana', 'editó un producto', 'Pizza muzzarella', '2026-09-10 12:00:00');
    anotar('Ana', 'ajustó el stock de un insumo', 'Mozzarella', '2026-09-11 09:00:00');
    anotar('Beto', 'editó un producto', 'Pizza napolitana', '2026-09-12 20:00:00');
    anotar('Beto', 'dio de alta una categoría', 'Postres', '2026-09-13 18:00:00');
  });

  it('filtra por persona', () => {
    const pagina = users.listarAuditoria({ limite: 50, desde: 0 }, { quien: 'Ana' });
    assert.equal(pagina.total, 2);
    assert.ok(pagina.items.every((f) => f.user_name === 'Ana'));
  });

  it('busca por lo que se tocó', () => {
    const pagina = users.listarAuditoria({ limite: 50, desde: 0 }, { texto: 'Pizza' });
    assert.equal(pagina.total, 2, 'las dos pizzas, sin importar quién');
  });

  it('acota por fecha, e incluye el día entero del "hasta"', () => {
    const pagina = users.listarAuditoria(
      { limite: 50, desde: 0 },
      { desde_fecha: '2026-09-11', hasta_fecha: '2026-09-12' },
    );
    assert.equal(pagina.total, 2, 'la del 12 a las 20:00 tiene que entrar');
  });

  it('combina los filtros', () => {
    const pagina = users.listarAuditoria(
      { limite: 50, desde: 0 },
      { quien: 'Beto', texto: 'producto' },
    );
    assert.equal(pagina.total, 1);
    assert.equal(pagina.items[0]?.target, 'Pizza napolitana');
  });

  it('sin resultados devuelve una página vacía, no un error', () => {
    const pagina = users.listarAuditoria({ limite: 50, desde: 0 }, { quien: 'Nadie' });
    assert.equal(pagina.total, 0);
    assert.equal(pagina.items.length, 0);
  });

  it('lista quiénes figuran, para el selector', () => {
    assert.deepEqual(users.quienesFiguranEnLaAuditoria(), ['Ana', 'Beto']);
  });
});
