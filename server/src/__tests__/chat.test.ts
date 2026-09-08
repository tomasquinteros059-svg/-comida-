import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('chat');

const { closeDb, all, run } = await import('../db/index.js');
const { createCategory, createProduct, getProduct, searchProducts } = await import('../domain/menu.js');
const { createIngredient, syncProductAvailability } = await import('../domain/stock.js');
const { createConversation, getConversationOrThrow } = await import('../domain/conversations.js');
const { respondDeterministic, parseOrderRequest } = await import('../chat/fallback.js');
const { runTool } = await import('../chat/tools.js');
const { newId } = await import('../lib/ids.js');

let empanada: string;
let soda: string;
let dessert: string;

before(() => {
  const savory = createCategory({ name: 'Empanadas' }).id;
  const drinks = createCategory({ name: 'Bebidas' }).id;

  empanada = createProduct({ name: 'Empanada de carne', category_id: savory, price_cents: 1_500 }).id;
  soda = createProduct({ name: 'Gaseosa 1.5 L', category_id: drinks, price_cents: 3_600 }).id;
  // Apagado a mano por el local: la sincronizacion automatica no debe pisarlo.
  dessert = createProduct({
    name: 'Flan casero',
    category_id: drinks,
    price_cents: 4_200,
    available: false,
    available_override: false,
  }).id;

  const cream = createIngredient({ name: 'Crema', unit: 'kg', stock_qty: 0.5, min_qty: 1, par_qty: 5 }).id;
  run('INSERT INTO recipe_items (id, product_id, ingredient_id, qty) VALUES (?,?,?,?)', [
    newId('rcp'), dessert, cream, 0.2,
  ]);
});

after(() => closeDb());

describe('interpretacion del pedido', () => {
  it('separa cantidades y productos', () => {
    const parsed = parseOrderRequest('hola, quiero 6 empanadas de carne y una gaseosa');
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.qty, 6);
    assert.match(parsed[0]!.query, /empanada/);
    assert.equal(parsed[1]!.qty, 1);
  });

  it('asume una unidad cuando no se dice cantidad', () => {
    const parsed = parseOrderRequest('dame un flan');
    assert.equal(parsed[0]!.qty, 1);
  });
});

describe('busqueda en la carta', () => {
  it('tolera plurales y errores de tipeo', () => {
    assert.equal(searchProducts('empanadas')[0]?.product.id, empanada);
    assert.equal(searchProducts('empanda de carne')[0]?.product.id, empanada);
    assert.equal(searchProducts('gaseoza')[0]?.product.id, soda);
  });

  it('no inventa resultados para lo que no vendemos', () => {
    assert.equal(searchProducts('sushi').length, 0);
  });
});

describe('toma de pedido punta a punta', () => {
  it('arma el carrito, lo valoriza y lo confirma', () => {
    const conversation = createConversation();

    const first = respondDeterministic('quiero 3 empanadas de carne y una gaseosa', conversation.id);
    assert.match(first.reply, /Empanada de carne/);

    const cart = getConversationOrThrow(conversation.id).cart;
    assert.equal(cart.length, 2);
    assert.equal(cart[0]!.qty, 3);

    const total = respondDeterministic('cuanto es el total?', conversation.id);
    // 3 x 1500 + 3600 = 8100
    assert.match(total.reply, /81,00|8\.100/);

    const done = respondDeterministic('confirmar', conversation.id);
    assert.match(done.reply, /numero 1/);
    assert.equal(getConversationOrThrow(conversation.id).cart.length, 0);
    assert.ok(getConversationOrThrow(conversation.id).order_id);
  });

  it('no agrega productos sin disponibilidad y ofrece alternativas', () => {
    const conversation = createConversation();
    const result = runTool(
      'agregar_al_pedido',
      { producto_id: dessert, cantidad: 1 },
      { conversationId: conversation.id },
    ) as { ok: boolean; alternativas?: unknown[] };

    assert.equal(result.ok, false);
    assert.equal(getConversationOrThrow(conversation.id).cart.length, 0);

    // Queda registrada la demanda perdida para que el local la vea.
    const signals = all<{ kind: string }>('SELECT kind FROM demand_signals');
    assert.ok(signals.some((s) => s.kind === 'sin_stock'));
  });

  it('registra lo que el cliente pide y no esta en la carta', () => {
    const conversation = createConversation();
    respondDeterministic('tenes sushi?', conversation.id);
    const signals = all<{ kind: string; query: string }>('SELECT kind, query FROM demand_signals');
    assert.ok(signals.some((s) => s.kind === 'no_esta_en_carta' && s.query.includes('sushi')));
  });

  it('no confirma un pedido vacio', () => {
    const conversation = createConversation();
    const result = respondDeterministic('confirmar', conversation.id);
    assert.match(result.reply, /vacio/);
  });

  it('quita una linea del pedido', () => {
    const conversation = createConversation();
    respondDeterministic('2 empanadas de carne', conversation.id);
    assert.equal(getConversationOrThrow(conversation.id).cart.length, 1);
    respondDeterministic('saca las empanadas', conversation.id);
    assert.equal(getConversationOrThrow(conversation.id).cart.length, 0);
  });
});

describe('disponibilidad manual', () => {
  it('sobrevive a la sincronizacion automatica por stock', () => {
    syncProductAvailability();
    assert.equal(getProduct(dessert)!.available, false);
  });
});

describe('herramientas del bot', () => {
  it('rechaza ids inventados en vez de fallar', () => {
    const conversation = createConversation();
    const result = runTool(
      'agregar_al_pedido',
      { producto_id: 'prd_inventado', cantidad: 1 },
      { conversationId: conversation.id },
    ) as { ok: boolean; error: string };
    assert.equal(result.ok, false);
    assert.match(result.error, /no existe/);
  });

  it('devuelve un error legible si la herramienta no existe', () => {
    const result = runTool('herramienta_fantasma', {}, { conversationId: 'x' }) as { error: string };
    assert.match(result.error, /desconocida/);
  });
});
