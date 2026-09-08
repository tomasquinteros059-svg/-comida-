import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('orders');

const { closeDb, run } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { advanceOrder, createOrder, priceCart, kitchenTicket } = await import('../domain/orders.js');
const { createIngredient, getIngredient, checkAvailability } = await import('../domain/stock.js');
const { newId } = await import('../lib/ids.js');

let categoryId: string;
let burger: string;
let soda: string;
let meat: string;
let bun: string;

before(() => {
  categoryId = createCategory({ name: 'Principales' }).id;

  meat = createIngredient({ name: 'Carne', unit: 'kg', stock_qty: 1, min_qty: 0.5, par_qty: 5 }).id;
  bun = createIngredient({ name: 'Pan', unit: 'un', stock_qty: 10, min_qty: 4, par_qty: 40 }).id;

  burger = createProduct({
    name: 'Hamburguesa',
    category_id: categoryId,
    price_cents: 10_000,
    cost_cents: 3_000,
  }).id;
  soda = createProduct({ name: 'Gaseosa', category_id: categoryId, price_cents: 3_000 }).id;

  // Receta: cada hamburguesa usa 200 g de carne y un pan.
  run('INSERT INTO recipe_items (id, product_id, ingredient_id, qty) VALUES (?,?,?,?)', [
    newId('rcp'), burger, meat, 0.2,
  ]);
  run('INSERT INTO recipe_items (id, product_id, ingredient_id, qty) VALUES (?,?,?,?)', [
    newId('rcp'), burger, bun, 1,
  ]);
});

after(() => closeDb());

describe('valorizacion del carrito', () => {
  it('calcula el total desde la carta, no desde el cliente', () => {
    const { lines, subtotal_cents } = priceCart([
      { product_id: burger, qty: 2, modifier_ids: [], note: '' },
      { product_id: soda, qty: 1, modifier_ids: [], note: '' },
    ]);
    assert.equal(subtotal_cents, 23_000);
    assert.equal(lines[0]!.line_total_cents, 20_000);
  });

  it('rechaza cantidades invalidas', () => {
    assert.throws(
      () => priceCart([{ product_id: burger, qty: 0, modifier_ids: [], note: '' }]),
      /Cantidad invalida/,
    );
  });
});

describe('stock', () => {
  it('detecta faltantes antes de aceptar el pedido', () => {
    // Hay 1 kg de carne: alcanza para 5 hamburguesas, no para 6.
    assert.equal(checkAvailability([{ product_id: burger, qty: 5, modifier_ids: [], note: '' }]).ok, true);
    const short = checkAvailability([{ product_id: burger, qty: 6, modifier_ids: [], note: '' }]);
    assert.equal(short.ok, false);
    assert.equal(short.shortages[0]!.ingredient_name, 'Carne');
    assert.equal(short.shortages[0]!.missing, 0.2);
  });

  it('descuenta insumos al confirmar y los devuelve al cancelar', () => {
    const order = createOrder({
      lines: [{ product_id: burger, qty: 2, modifier_ids: [], note: '' }],
      confirm: true,
    });
    assert.equal(order.status, 'confirmado');
    assert.equal(getIngredient(meat)!.stock_qty, 0.6);
    assert.equal(getIngredient(bun)!.stock_qty, 8);

    advanceOrder(order.id, 'cancelado');
    assert.equal(getIngredient(meat)!.stock_qty, 1);
    assert.equal(getIngredient(bun)!.stock_qty, 10);
  });

  it('no confirma un pedido que no se puede cocinar', () => {
    assert.throws(
      () =>
        createOrder({
          lines: [{ product_id: burger, qty: 99, modifier_ids: [], note: '' }],
          confirm: true,
        }),
      /No alcanza el stock/,
    );
  });
});

describe('maquina de estados', () => {
  it('respeta las transiciones validas', () => {
    const order = createOrder({
      lines: [{ product_id: soda, qty: 1, modifier_ids: [], note: '' }],
      confirm: true,
    });
    assert.equal(advanceOrder(order.id, 'en_preparacion').status, 'en_preparacion');
    assert.equal(advanceOrder(order.id, 'listo').status, 'listo');
    assert.equal(advanceOrder(order.id, 'entregado').status, 'entregado');
  });

  it('rechaza saltos invalidos', () => {
    const order = createOrder({
      lines: [{ product_id: soda, qty: 1, modifier_ids: [], note: '' }],
    });
    assert.throws(() => advanceOrder(order.id, 'listo'), /No se puede pasar/);
  });

  it('numera los pedidos del dia en secuencia', () => {
    const a = createOrder({ lines: [{ product_id: soda, qty: 1, modifier_ids: [], note: '' }] });
    const b = createOrder({ lines: [{ product_id: soda, qty: 1, modifier_ids: [], note: '' }] });
    assert.equal(b.daily_number, a.daily_number + 1);
  });
});

describe('ticket de cocina', () => {
  it('incluye el numero del dia y las lineas del pedido', () => {
    const order = createOrder({
      lines: [{ product_id: soda, qty: 3, modifier_ids: [], note: 'bien fria' }],
      table_label: '7',
    });
    const ticket = kitchenTicket(order.id);
    assert.match(ticket, /PEDIDO #/);
    assert.match(ticket, /3 x Gaseosa/);
    assert.match(ticket, /bien fria/);
    assert.match(ticket, /MESA 7/);
  });
});
