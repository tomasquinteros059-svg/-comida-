import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('reservations');

const { closeDb, run } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { createIngredient } = await import('../domain/stock.js');
const { checkAvailability, orderableNow } = await import('../domain/stock.js');
const { createConversation, saveCart } = await import('../domain/conversations.js');
const { createOrder } = await import('../domain/orders.js');
const { newId } = await import('../lib/ids.js');

let empanada: string;

before(() => {
  const category = createCategory({ name: 'Empanadas' }).id;
  // Alcanza exactamente para 10 empanadas.
  const tapas = createIngredient({ name: 'Tapas', unit: 'un', stock_qty: 10, min_qty: 20, par_qty: 100 }).id;
  empanada = createProduct({ name: 'Empanada de carne', category_id: category, price_cents: 1_500 }).id;
  run('INSERT INTO recipe_items (id, product_id, ingredient_id, qty) VALUES (?,?,?,?)', [
    newId('rcp'), empanada, tapas, 1,
  ]);
});

// Cada caso arranca sin carritos abiertos: si no, las reservas de un test
// siguen reteniendo stock en el siguiente.
beforeEach(() => run('DELETE FROM conversations'));

after(() => closeDb());

const line = (qty: number) => ({ product_id: empanada, qty, modifier_ids: [], note: '' });

describe('reservas de carritos abiertos', () => {
  it('sin carritos abiertos solo cuenta el stock real', () => {
    assert.equal(checkAvailability([line(10)]).ok, true);
    assert.equal(checkAvailability([line(11)]).ok, false);
  });

  it('un carrito abierto retiene stock para los demas', () => {
    const ana = createConversation();
    saveCart(ana.id, [line(8)]);

    const beto = createConversation();
    // Quedan 2 libres: 3 ya no entran.
    const short = checkAvailability([line(3)], { conversationId: beto.id });
    assert.equal(short.ok, false);
    assert.equal(short.shortages[0]?.reserved, 8);
    assert.equal(checkAvailability([line(2)], { conversationId: beto.id }).ok, true);
  });

  it('el carrito propio no se cuenta dos veces', () => {
    const ana = createConversation();
    saveCart(ana.id, [line(8)]);
    // Ana reemplaza su carrito por 9: no compite consigo misma.
    assert.equal(checkAvailability([line(9)], { conversationId: ana.id }).ok, true);
  });

  it('la carta que ve el bot deja de ofrecer lo reservado', () => {
    const ana = createConversation();
    saveCart(ana.id, [line(10)]);
    const beto = createConversation();
    assert.equal(orderableNow(beto.id).get(empanada), false, 'para Beto ya no hay');
    assert.equal(orderableNow(ana.id).get(empanada), true, 'Ana sigue viendo lo suyo');
  });

  it('libera lo que quedo en un carrito viejo', () => {
    const viejo = createConversation();
    saveCart(viejo.id, [line(10)]);
    run("UPDATE conversations SET updated_at = datetime('now', '-40 minutes') WHERE id = ?", [viejo.id]);
    const nuevo = createConversation();
    assert.equal(checkAvailability([line(10)], { conversationId: nuevo.id }).ok, true);
  });

  it('confirmar compite contra el stock real, no contra las reservas', () => {
    const ana = createConversation();
    saveCart(ana.id, [line(9)]);
    // Beto confirma primero y se lleva las 10: el carrito de Ana no lo bloquea.
    const order = createOrder({ lines: [line(10)], confirm: true });
    assert.equal(order.status, 'confirmado');
    // Y ahora no queda nada para nadie.
    assert.equal(checkAvailability([line(1)], { ignoreReservations: true }).ok, false);
  });
});
