import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('analytics');

const { closeDb, run } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { laggingProducts, menuPerformance, salesSummary, todayIso } = await import('../domain/analytics.js');
const { newId, shortCode } = await import('../lib/ids.js');

let star: string;
let dog: string;
let fading: string;

/** Inserta un pedido entregado en una fecha concreta, saltando la logica de stock. */
function seedSale(productId: string, qty: number, priceCents: number, costCents: number, daysAgo: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const at = date.toISOString().slice(0, 19).replace('T', ' ');
  const orderId = newId('ord');
  run(
    `INSERT INTO orders (id, code, daily_number, channel, status, service_type, subtotal_cents,
       total_cents, created_at, confirmed_at)
     VALUES (?,?,?, 'chat', 'entregado', 'local', ?, ?, ?, ?)`,
    [orderId, shortCode('PED'), 1, priceCents * qty, priceCents * qty, at, at],
  );
  run(
    `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price_cents,
       unit_cost_cents, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [newId('oit'), orderId, productId, 'x', qty, priceCents, costCents, at],
  );
}

before(() => {
  const category = createCategory({ name: 'Platos' }).id;
  star = createProduct({ name: 'Estrella', category_id: category, price_cents: 10_000, cost_cents: 2_000 }).id;
  dog = createProduct({ name: 'Olvidado', category_id: category, price_cents: 4_000, cost_cents: 3_500 }).id;
  fading = createProduct({ name: 'En caida', category_id: category, price_cents: 9_000, cost_cents: 2_000 }).id;

  // La estrella vende parejo todos los dias.
  for (let d = 1; d <= 40; d++) seedSale(star, 10, 10_000, 2_000, d);
  // El que se cae vendia bien y dejo de venderse.
  for (let d = 31; d <= 40; d++) seedSale(fading, 8, 9_000, 2_000, d);
  for (let d = 1; d <= 10; d++) seedSale(fading, 1, 9_000, 2_000, d);
  // "Olvidado" no vendio nada nunca.
});

after(() => closeDb());

describe('resumen de ventas', () => {
  it('suma facturacion, costo y margen del periodo', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const day = yesterday.toISOString().slice(0, 10);

    const summary = salesSummary(day, day);
    assert.equal(summary.orders, 2);
    assert.equal(summary.revenue_cents, 10 * 10_000 + 1 * 9_000);
    assert.equal(summary.margin_cents, summary.revenue_cents - summary.cost_cents);
    assert.equal(summary.avg_ticket_cents, Math.round(summary.revenue_cents / 2));
  });

  it('devuelve ceros para un dia sin ventas', () => {
    const summary = salesSummary(todayIso(), todayIso());
    assert.equal(summary.orders, 0);
    assert.equal(summary.avg_ticket_cents, 0);
  });
});

describe('ingenieria de carta', () => {
  it('clasifica cada plato por popularidad y margen', () => {
    const performance = menuPerformance(30);
    const byName = new Map(performance.map((p) => [p.name, p]));
    assert.equal(byName.get('Estrella')!.classification, 'estrella');
    assert.equal(byName.get('Olvidado')!.classification, 'perro');
    assert.equal(byName.get('Estrella')!.margin_cents, 8_000);
  });
});

describe('productos rezagados', () => {
  it('detecta lo que dejo de venderse', () => {
    const lagging = laggingProducts(30);
    const names = lagging.map((p) => p.name);
    assert.ok(names.includes('Olvidado'), 'el que nunca vendio debe aparecer');
    assert.match(lagging.find((p) => p.name === 'Olvidado')!.reason, /Sin ventas/);
  });

  it('detecta la caida contra el periodo anterior', () => {
    // Ventana de 30 dias: se compara lo vendido en el ultimo mes contra el anterior.
    const fadingReport = laggingProducts(30).find((p) => p.name === 'En caida');
    assert.ok(fadingReport, 'el producto en caida debe estar en el reporte');
    assert.match(fadingReport!.reason, /Cayo \d+% por dia/);
  });

  it('no marca como rezagado al que vende bien', () => {
    assert.equal(laggingProducts(30).some((p) => p.name === 'Estrella'), false);
  });
});
