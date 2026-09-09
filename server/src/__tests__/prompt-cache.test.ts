import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('prompt-cache');

const { closeDb, run } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { createIngredient, adjustStock, syncProductAvailability } = await import('../domain/stock.js');
const { createConversation, saveCart } = await import('../domain/conversations.js');
const { createKnowledge } = await import('../domain/knowledge.js');
const { buildSystemPrompt } = await import('../chat/prompt.js');
const { newId } = await import('../lib/ids.js');

let empanada: string;
let tapas: string;

before(() => {
  const category = createCategory({ name: 'Empanadas' }).id;
  tapas = createIngredient({ name: 'Tapas', unit: 'un', stock_qty: 50, min_qty: 20, par_qty: 200 }).id;
  empanada = createProduct({ name: 'Empanada de carne', category_id: category, price_cents: 150_000 }).id;
  createProduct({ name: 'Gaseosa', category_id: category, price_cents: 360_00 });
  run('INSERT INTO recipe_items (id, product_id, ingredient_id, qty) VALUES (?,?,?,?)', [
    newId('rcp'), empanada, tapas, 1,
  ]);
  createKnowledge({ topic: 'Horarios', content: 'De martes a domingo, de 11 a 23.' });
});

// Cada caso arranca sin carritos abiertos: si no, la reserva de un test sigue
// reteniendo stock en el siguiente y la disponibilidad no es la que se cree.
beforeEach(() => run('DELETE FROM conversations'));

after(() => closeDb());

/**
 * El prefijo cacheado es un prefijo exacto: un solo byte distinto lo invalida
 * y el ahorro desaparece sin que nada avise. Estos tests son la red que atrapa
 * eso cuando alguien toque el armado del prompt.
 */
describe('estabilidad del prefijo cacheado', () => {
  it('no cambia cuando se mueve el stock', () => {
    const antes = buildSystemPrompt().stable;

    adjustStock(tapas, -50, 'venta', { note: 'se vendio todo' });
    syncProductAvailability();

    assert.equal(buildSystemPrompt().stable, antes, 'una venta no puede invalidar el cache de la carta');
  });

  it('no cambia cuando otro carrito reserva', () => {
    adjustStock(tapas, 50, 'compra');
    syncProductAvailability();
    const antes = buildSystemPrompt().stable;

    const otro = createConversation();
    saveCart(otro.id, [{ product_id: empanada, qty: 50, modifier_ids: [], note: '' }]);

    assert.equal(buildSystemPrompt().stable, antes);
  });

  it('no cambia entre conversaciones distintas', () => {
    const ana = createConversation();
    const beto = createConversation();
    assert.equal(buildSystemPrompt(ana.id).stable, buildSystemPrompt(beto.id).stable);
  });

  it('la disponibilidad viaja en la parte volátil, no en la cacheada', () => {
    adjustStock(tapas, -1000, 'ajuste');
    syncProductAvailability();

    const { stable, volatile } = buildSystemPrompt();
    assert.ok(volatile.includes('Empanada de carne'), 'lo que falta se avisa aparte');
    assert.ok(!stable.includes('SIN STOCK'), 'la carta cacheada no lleva marcas de stock');
    assert.ok(stable.includes('Empanada de carne'), 'pero el producto sigue en la carta');
  });

  it('avisa explícitamente cuando está todo disponible', () => {
    adjustStock(tapas, 1000, 'compra');
    syncProductAvailability();
    assert.match(buildSystemPrompt().volatile, /todo disponible/i);
  });

  // Que el prefijo supere el mínimo cacheable (512 tokens en Opus 5, 1024 en
  // Sonnet 5) depende del tamaño de la carta de cada local, no del código: un
  // local con cinco platos no llega y no hay nada que arreglar acá. La verdad
  // la dice el uso real, que el motor registra en cada llamada.
});
