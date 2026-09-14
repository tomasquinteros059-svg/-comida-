import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('cobros');
process.env.MERCADOPAGO_ACCESS_TOKEN = 'token-de-prueba';
process.env.MERCADOPAGO_WEBHOOK_SECRET = 'clave-del-webhook';
process.env.PUBLIC_URL = 'https://pedidos.ejemplo.com';

const SECRETO = 'clave-del-webhook';

const { closeDb, get } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { createOrder, getOrderOrThrow } = await import('../domain/orders.js');
const cobros = await import('../domain/cobros.js');

let base: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let producto: string;
/** Lo que responde la API de Mercado Pago de mentira. */
let respuestaDeMp: (url: string, init?: RequestInit) => Response;

before(async () => {
  const categoria = createCategory({ name: 'Pizzas' }).id;
  producto = createProduct({ name: 'Pizza muzzarella', category_id: categoria, price_cents: 1_100_000 }).id;

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const destino = String(url);
    if (destino.includes('mercadopago.com')) return respuestaDeMp(destino, init);
    return original(url as never, init);
  }) as typeof fetch;

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
});

const nuevoPedido = (qty = 1) => createOrder({ lines: [{ product_id: producto, qty }], confirm: true }).id;

describe('cobrar en el mostrador', () => {
  it('marcar pagado deja el pedido pagado, con el medio', () => {
    const pedido = nuevoPedido();
    assert.equal(getOrderOrThrow(pedido).payment_status, 'sin_pagar');

    cobros.marcarPagado(pedido, 'efectivo');
    const despues = getOrderOrThrow(pedido);
    assert.equal(despues.payment_status, 'pagado');
    assert.equal(despues.payment_method, 'efectivo');
    assert.ok(despues.paid_at);
  });

  it('queda registrado, no solo el estado', () => {
    const pedido = nuevoPedido();
    cobros.marcarPagado(pedido, 'debito', 'terminal 2');
    const pagos = cobros.pagosDe(pedido);
    assert.equal(pagos.length, 1);
    assert.equal(pagos[0]!.estado, 'aprobado');
    assert.equal(pagos[0]!.monto_cents, 1_100_000);
    assert.equal(pagos[0]!.detalle, 'terminal 2');
  });

  it('se puede deshacer cuando se cobró el pedido equivocado', () => {
    const pedido = nuevoPedido();
    cobros.marcarPagado(pedido, 'efectivo');
    cobros.desmarcarPagado(pedido, 'era el otro');

    assert.equal(getOrderOrThrow(pedido).payment_status, 'sin_pagar');
    const pagos = cobros.pagosDe(pedido);
    assert.equal(pagos.length, 2, 'el registro guarda las dos cosas, no borra la primera');
    assert.equal(pagos[1]!.estado, 'devuelto');
  });

  it('un pedido cancelado no se cobra', async () => {
    const { advanceOrder } = await import('../domain/orders.js');
    const pedido = nuevoPedido();
    advanceOrder(pedido, 'cancelado');
    assert.throws(() => cobros.marcarPagado(pedido, 'efectivo'), /cancelado/);
  });

  it('un medio de pago inventado se rechaza', () => {
    const pedido = nuevoPedido();
    assert.throws(() => cobros.marcarPagado(pedido, 'bitcoin' as never), /Medio de pago/);
  });

  it('el estado del pago es independiente del estado del pedido', async () => {
    const { advanceOrder } = await import('../domain/orders.js');
    const pedido = nuevoPedido();
    advanceOrder(pedido, 'en_preparacion');
    advanceOrder(pedido, 'listo');
    advanceOrder(pedido, 'entregado');
    // Entregado y sin pagar: la cuenta que se paga al final.
    assert.equal(getOrderOrThrow(pedido).payment_status, 'sin_pagar');
    cobros.marcarPagado(pedido, 'efectivo');
    assert.equal(getOrderOrThrow(pedido).status, 'entregado');
    assert.equal(getOrderOrThrow(pedido).payment_status, 'pagado');
  });
});

describe('el cierre de caja', () => {
  it('suma por medio de pago y muestra lo que falta cobrar', () => {
    const a = nuevoPedido(2);
    const b = nuevoPedido(1);
    nuevoPedido(1); // este queda sin cobrar

    cobros.marcarPagado(a, 'efectivo');
    cobros.marcarPagado(b, 'debito');

    const caja = cobros.resumenDeCaja();
    const efectivo = caja.por_medio.find((m) => m.payment_method === 'efectivo');
    assert.ok(efectivo && efectivo.total_cents >= 2_200_000);
    assert.ok(caja.cobrado_cents > 0);
    assert.ok(caja.sin_cobrar > 0, 'tiene que ver el que falta');
  });

  it('lo pendiente no incluye cancelados', async () => {
    const { advanceOrder } = await import('../domain/orders.js');
    const pedido = nuevoPedido();
    advanceOrder(pedido, 'cancelado');
    const pendientes = cobros.sinCobrar();
    assert.ok(!pendientes.pedidos.some((p) => p.id === pedido), 'un cancelado no se cobra');
  });
});

describe('el link de pago', () => {
  beforeEach(() => {
    respuestaDeMp = () =>
      new Response(
        JSON.stringify({ id: 'pref-123', init_point: 'https://mp.com/pagar/abc' }),
        { status: 200 },
      );
  });

  it('crea el link y deja el pedido esperando pago', async () => {
    const pedido = nuevoPedido();
    const link = await cobros.crearLinkDePago(pedido);

    assert.equal(link.link, 'https://mp.com/pagar/abc');
    assert.equal(getOrderOrThrow(pedido).payment_status, 'pendiente');
    assert.equal(cobros.pagosDe(pedido)[0]!.estado, 'pendiente');
  });

  it('manda el id del pedido, que es lo que permite reconocerlo al volver', async () => {
    const pedido = nuevoPedido();
    let enviado: Record<string, unknown> = {};
    respuestaDeMp = (_url, init) => {
      enviado = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ id: 'p', init_point: 'https://mp.com/x' }), { status: 200 });
    };
    await cobros.crearLinkDePago(pedido);
    assert.equal(enviado.external_reference, pedido);
    assert.match(String(enviado.notification_url), /\/api\/cobros\/webhook$/);
  });

  it('no cobra dos veces lo mismo', async () => {
    const pedido = nuevoPedido();
    cobros.marcarPagado(pedido, 'efectivo');
    await assert.rejects(cobros.crearLinkDePago(pedido), /ya está pagado/);
  });

  it('si Mercado Pago rechaza, lo dice y no deja el pedido en pendiente', async () => {
    const pedido = nuevoPedido();
    respuestaDeMp = () => new Response('{"message":"invalid token"}', { status: 401 });
    await assert.rejects(cobros.crearLinkDePago(pedido), /no aceptó el cobro/);
    assert.equal(getOrderOrThrow(pedido).payment_status, 'sin_pagar');
  });
});

describe('el aviso de Mercado Pago', () => {
  const firmar = (dataId: string, requestId: string, ts = '1700000000') => {
    const plantilla = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const v1 = createHmac('sha256', SECRETO).update(plantilla).digest('hex');
    return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId };
  };

  const avisar = (dataId: string, cabeceras: Record<string, string>) =>
    fetch(`${base}/api/cobros/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...cabeceras },
      body: JSON.stringify({ type: 'payment', data: { id: dataId } }),
    });

  it('sin firma no entra', async () => {
    const res = await avisar('999', {});
    assert.equal(res.status, 401);
  });

  it('con una firma de otra clave tampoco', async () => {
    const plantilla = `id:999;request-id:r1;ts:1700000000;`;
    const v1 = createHmac('sha256', 'otra-clave').update(plantilla).digest('hex');
    const res = await avisar('999', { 'x-signature': `ts=1700000000,v1=${v1}`, 'x-request-id': 'r1' });
    assert.equal(res.status, 401);
  });

  it('NO se cree lo que dice el aviso: consulta el estado real', async () => {
    const pedido = nuevoPedido();
    let consultado = '';
    respuestaDeMp = (url) => {
      consultado = url;
      return new Response(
        JSON.stringify({ id: 777, status: 'approved', external_reference: pedido, transaction_amount: 11000 }),
        { status: 200 },
      );
    };

    const res = await avisar('777', firmar('777', 'r1'));
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));

    assert.match(consultado, /\/v1\/payments\/777$/, 'tiene que preguntarle a Mercado Pago');
    assert.equal(getOrderOrThrow(pedido).payment_status, 'pagado');
  });

  it('un pago por menos plata NO da el pedido por pagado', async () => {
    const pedido = nuevoPedido();
    respuestaDeMp = () =>
      new Response(
        JSON.stringify({ id: 888, status: 'approved', external_reference: pedido, transaction_amount: 1 }),
        { status: 200 },
      );

    const resultado = await cobros.procesarAviso('888');
    assert.equal(resultado.aplicado, false);
    assert.match(resultado.motivo ?? '', /El pago dice \$1 y el pedido es de/);
    assert.equal(getOrderOrThrow(pedido).payment_status, 'sin_pagar', '$1 por una pizza de $11.000 no es un redondeo');
    assert.equal(cobros.pagosDe(pedido).length, 1, 'igual queda registrado para que alguien lo mire');
  });

  it('un rechazo deja el pedido sin pagar', async () => {
    const pedido = nuevoPedido();
    respuestaDeMp = () =>
      new Response(
        JSON.stringify({ id: 999, status: 'rejected', external_reference: pedido, transaction_amount: 11000 }),
        { status: 200 },
      );
    await cobros.procesarAviso('999');
    assert.equal(getOrderOrThrow(pedido).payment_status, 'sin_pagar');
    assert.equal(cobros.pagosDe(pedido)[0]!.estado, 'rechazado');
  });

  it('una devolución lo marca devuelto', async () => {
    const pedido = nuevoPedido();
    respuestaDeMp = () =>
      new Response(
        JSON.stringify({ id: 1000, status: 'refunded', external_reference: pedido, transaction_amount: 11000 }),
        { status: 200 },
      );
    await cobros.procesarAviso('1000');
    assert.equal(getOrderOrThrow(pedido).payment_status, 'devuelto');
  });

  it('el mismo aviso dos veces no duplica el registro', async () => {
    const pedido = nuevoPedido();
    respuestaDeMp = () =>
      new Response(
        JSON.stringify({ id: 1234, status: 'approved', external_reference: pedido, transaction_amount: 11000 }),
        { status: 200 },
      );
    await cobros.procesarAviso('1234');
    await cobros.procesarAviso('1234');
    assert.equal(cobros.pagosDe(pedido).length, 1, 'Mercado Pago reintenta: no puede sumar dos veces');
  });

  it('un aviso de un pedido que no existe no rompe', async () => {
    respuestaDeMp = () =>
      new Response(
        JSON.stringify({ id: 1, status: 'approved', external_reference: 'ord_inventado', transaction_amount: 1 }),
        { status: 200 },
      );
    const r = await cobros.procesarAviso('1');
    assert.equal(r.aplicado, false);
    assert.match(r.motivo ?? '', /No existe el pedido/);
  });

  it('traduce los estados de Mercado Pago', () => {
    assert.equal(cobros.mapearEstado('approved'), 'aprobado');
    assert.equal(cobros.mapearEstado('refunded'), 'devuelto');
    assert.equal(cobros.mapearEstado('charged_back'), 'devuelto');
    assert.equal(cobros.mapearEstado('rejected'), 'rechazado');
    assert.equal(cobros.mapearEstado('in_process'), 'pendiente');
    assert.equal(cobros.mapearEstado('lo-que-sea'), 'pendiente');
  });
});
