import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('retencion');

const { closeDb, run, get } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { createOrder } = await import('../domain/orders.js');
const retencion = await import('../domain/retencion.js');

/** Crea una conversación con dos mensajes, fechada hace `dias` días. */
function conversacionDeHace(dias: number, opciones: { conPedido?: string } = {}) {
  const id = `cnv_prueba_${Math.random().toString(36).slice(2, 10)}`;
  run(
    `INSERT INTO conversations (id, channel, order_id, created_at, updated_at)
     VALUES (?, 'chat', ?, datetime('now', ?), datetime('now', ?))`,
    [id, opciones.conPedido ?? null, `-${dias} days`, `-${dias} days`],
  );
  for (const [rol, texto] of [['user', 'soy Ana, mi telefono es 11-5555-1234'], ['assistant', 'listo']]) {
    run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, datetime('now', ?))`,
      [`msg_${Math.random().toString(36).slice(2, 10)}`, id, rol, texto, `-${dias} days`],
    );
  }
  return id;
}

let pedido: string;

before(() => {
  const categoria = createCategory({ name: 'Empanadas' }).id;
  const producto = createProduct({
    name: 'Empanada de carne',
    category_id: categoria,
    price_cents: 150_000,
  }).id;
  pedido = createOrder({ lines: [{ product_id: producto, qty: 1 }] }).id;
});

after(() => closeDb());

describe('retención de conversaciones', () => {
  before(() => {
    run('DELETE FROM messages');
    run('DELETE FROM conversations');
    conversacionDeHace(200);
    conversacionDeHace(120);
    conversacionDeHace(10);
    conversacionDeHace(1);
    // Una vieja que terminó en pedido: esa no se toca.
    conversacionDeHace(300, { conPedido: pedido });
    retencion.fijarDiasDeRetencion(90);
  });

  it('borra lo que pasó el plazo y deja lo de adentro', () => {
    const antes = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n;
    assert.equal(antes, 5);

    const purga = retencion.purgarConversacionesViejas();
    assert.equal(purga.conversaciones, 2, 'la de 200 y la de 120 días');
    assert.equal(purga.mensajes, 4);

    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n, 3);
  });

  it('nunca borra una conversación que terminó en pedido', () => {
    // La de 300 días sigue ahí: la charla es parte de esa venta.
    const conPedido = get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM conversations WHERE order_id IS NOT NULL',
    )!.n;
    assert.equal(conPedido, 1, 'las ventas son la contabilidad del local');
  });

  it('no deja mensajes huérfanos', () => {
    const huerfanos = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages
       WHERE conversation_id NOT IN (SELECT id FROM conversations)`,
    )!.n;
    assert.equal(huerfanos, 0);
  });

  it('correrlo dos veces no borra de más', () => {
    const segunda = retencion.purgarConversacionesViejas();
    assert.equal(segunda.conversaciones, 0);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n, 3);
  });

  it('en cero no borra nada: es una decisión explícita del local', () => {
    retencion.fijarDiasDeRetencion(0);
    conversacionDeHace(500);
    const purga = retencion.purgarConversacionesViejas();
    assert.equal(purga.conversaciones, 0);
    assert.equal(get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')!.n, 4);
  });

  it('rechaza un plazo imposible', () => {
    assert.throws(() => retencion.fijarDiasDeRetencion(-1), /retención/);
    assert.throws(() => retencion.fijarDiasDeRetencion(99_999), /retención/);
  });

  it('el estado dice qué hay y qué se va a borrar', () => {
    retencion.fijarDiasDeRetencion(90);
    const estado = retencion.estadoDeRetencion();
    assert.equal(estado.dias, 90);
    assert.equal(estado.con_pedido, 1);
    assert.equal(estado.a_borrar, 1, 'la de 500 días que se acaba de agregar');
    assert.ok(estado.total >= 4);
  });

  it('el plazo sobrevive al reinicio, porque va en la base', () => {
    retencion.fijarDiasDeRetencion(30);
    assert.equal(retencion.diasDeRetencion(), 30);
  });
});
