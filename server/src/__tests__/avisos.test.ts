import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('avisos');
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
process.env.WHATSAPP_TOKEN = 'token-de-prueba';
process.env.WHATSAPP_VERIFY_TOKEN = 'la-palabra';
process.env.WHATSAPP_APP_SECRET = 'la-clave';
// `habilitadoEnProduccion` no avisa en modo test, y acá se prueba justamente
// el aviso: se hace pasar por producción.
process.env.NODE_ENV = 'production';
process.env.ADMIN_TOKEN = 'un-token-largo-para-las-pruebas';

const { closeDb, run } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { createOrder, advanceOrder } = await import('../domain/orders.js');
const { createConversation } = await import('../domain/conversations.js');
const avisos = await import('../domain/avisos.js');

let producto: string;
/** Lo que se le habría mandado al cliente, sin salir a internet. */
let enviados: Array<{ a: string; texto: string }> = [];
/** Qué contesta Meta. Se cambia para probar los reintentos. */
let respuestas: Array<{ estado: number; retryAfter?: string }> = [];

before(() => {
  const categoria = createCategory({ name: 'Empanadas' }).id;
  producto = createProduct({
    name: 'Empanada de carne',
    category_id: categoria,
    price_cents: 150_000,
  }).id;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('graph.facebook.com')) {
      const cuerpo = JSON.parse(String(init?.body ?? '{}'));
      if (cuerpo.status === 'read') return new Response('{}', { status: 200 });

      const plan = respuestas.shift();
      if (plan && plan.estado !== 200) {
        return new Response(JSON.stringify({ error: { message: 'uf' } }), {
          status: plan.estado,
          headers: plan.retryAfter ? { 'retry-after': plan.retryAfter } : {},
        });
      }
      enviados.push({ a: cuerpo.to, texto: cuerpo.text?.body ?? '' });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.ok' }] }), { status: 200 });
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;
});

after(() => closeDb());

beforeEach(() => {
  enviados = [];
  respuestas = [];
  avisos.guardarConfigDeAvisos({ activo: true, demoraMin: 30 });
});

/** Un pedido que entró por WhatsApp, con su conversación atada. */
const pedidoPorWhatsapp = (telefono: string, servicio: 'local' | 'delivery' = 'local') => {
  const pedido = createOrder({
    lines: [{ product_id: producto, qty: 6 }],
    service_type: servicio,
  });
  const conversacion = createConversation({ channel: 'whatsapp', customer_name: 'Vecino' });
  run('UPDATE conversations SET external_id = ?, order_id = ? WHERE id = ?', [
    telefono,
    pedido.id,
    conversacion.id,
  ]);
  return pedido;
};

/**
 * Espera a que hayan salido `cuantos` avisos.
 *
 * Los avisos se disparan sin await desde `advanceOrder`, así que esperar un
 * tiempo fijo hace un test que falla cuando la máquina está cargada y —peor—
 * que a veces ve el aviso del test anterior todavía en vuelo. Se espera el
 * resultado, no el reloj.
 */
const esperarAvisos = async (cuantos: number, ms = 3000): Promise<void> => {
  const hasta = Date.now() + ms;
  while (enviados.length < cuantos && Date.now() < hasta) {
    await new Promise((listo) => setTimeout(listo, 20));
  }
};

/** Para los casos donde se comprueba que NO sale nada. */
const respirar = () => new Promise((listo) => setTimeout(listo, 400));

describe('avisarle al cliente cómo va su pedido', () => {
  it('al confirmar, le dice que lo tomaron y cuánto tarda', async () => {
    const pedido = pedidoPorWhatsapp('5491155550001');
    advanceOrder(pedido.id, 'confirmado');
    await esperarAvisos(1);

    assert.equal(enviados.length, 1, 'tiene que haber salido un aviso');
    assert.equal(enviados[0]!.a, '5491155550001');
    assert.match(enviados[0]!.texto, /tomamos tu pedido/i);
    assert.match(enviados[0]!.texto, /30 minutos/, 'la demora prometida sale del ajuste');
    assert.match(enviados[0]!.texto, new RegExp(pedido.code), 'va el código que se canta');
  });

  it('al estar listo, le dice que lo pase a buscar', async () => {
    const pedido = pedidoPorWhatsapp('5491155550002');
    advanceOrder(pedido.id, 'confirmado');
    advanceOrder(pedido.id, 'en_preparacion');
    advanceOrder(pedido.id, 'listo');
    await esperarAvisos(2);

    const textos = enviados.map((e) => e.texto).join(' | ');
    assert.equal(enviados.length, 2, `salieron: ${textos}`);
    assert.match(enviados[1]!.texto, /ya está listo/i);
  });

  it('en delivery el mensaje es otro: salió, no lo pases a buscar', async () => {
    const pedido = pedidoPorWhatsapp('5491155550003', 'delivery');
    advanceOrder(pedido.id, 'confirmado');
    advanceOrder(pedido.id, 'en_preparacion');
    advanceOrder(pedido.id, 'listo');
    await esperarAvisos(2);

    assert.equal(enviados.length, 2, enviados.map((e) => e.texto).join(' | '));
    assert.match(enviados[1]!.texto, /salió para allá/i);
    assert.doesNotMatch(enviados[1]!.texto, /pasás a buscar/i);
  });

  it('"en preparación" no se avisa: no le cambia nada al que espera', async () => {
    const pedido = pedidoPorWhatsapp('5491155550004');
    advanceOrder(pedido.id, 'confirmado');
    await esperarAvisos(1);
    enviados = [];

    advanceOrder(pedido.id, 'en_preparacion');
    await respirar();
    assert.equal(enviados.length, 0);
  });

  it('"entregado" tampoco: lo tiene en la mano', async () => {
    const pedido = pedidoPorWhatsapp('5491155550005');
    advanceOrder(pedido.id, 'confirmado');
    advanceOrder(pedido.id, 'en_preparacion');
    advanceOrder(pedido.id, 'listo');
    await esperarAvisos(2);
    enviados = [];

    advanceOrder(pedido.id, 'entregado');
    await respirar();
    assert.equal(enviados.length, 0);
  });

  it('si lo cancelan, le dice el motivo', async () => {
    const pedido = pedidoPorWhatsapp('5491155550006');
    advanceOrder(pedido.id, 'confirmado');
    await esperarAvisos(1);
    enviados = [];

    advanceOrder(pedido.id, 'cancelado', { note: 'se nos acabó la carne' });
    await esperarAvisos(1);
    assert.equal(enviados.length, 1);
    assert.match(enviados[0]!.texto, /se nos acabó la carne/);
  });

  it('un pedido del mostrador no avisa a nadie', async () => {
    const pedido = createOrder({ lines: [{ product_id: producto, qty: 2 }] });
    advanceOrder(pedido.id, 'confirmado');
    await respirar();
    assert.equal(enviados.length, 0, 'no hay teléfono al que avisarle');
  });

  it('el mismo aviso no sale dos veces', async () => {
    const pedido = pedidoPorWhatsapp('5491155550007');
    advanceOrder(pedido.id, 'confirmado');
    await esperarAvisos(1);
    assert.equal(enviados.length, 1);

    // Volver a pedir el mismo aviso a mano: es lo que pasa si alguien mueve el
    // pedido de ida y de vuelta.
    const otra = await avisos.avisarCambioDeEstado(pedido.id, 'confirmado');
    assert.equal(otra.mandado, false);
    assert.match(otra.motivo ?? '', /ya se había avisado/);
    assert.equal(enviados.length, 1, 'un segundo "ya está listo" manda al cliente al mostrador');
  });

  it('apagados, no sale ninguno', async () => {
    avisos.guardarConfigDeAvisos({ activo: false });
    const pedido = pedidoPorWhatsapp('5491155550008');
    advanceOrder(pedido.id, 'confirmado');
    await respirar();
    assert.equal(enviados.length, 0);
  });

  it('con la demora en cero no promete un tiempo que no puede cumplir', async () => {
    avisos.guardarConfigDeAvisos({ demoraMin: 0 });
    const pedido = pedidoPorWhatsapp('5491155550009');
    advanceOrder(pedido.id, 'confirmado');
    await esperarAvisos(1);
    assert.match(enviados[0]!.texto, /tomamos tu pedido/i);
    assert.doesNotMatch(enviados[0]!.texto, /minutos/);
  });

  it('una demora imposible se rechaza en vez de guardarse', () => {
    assert.throws(() => avisos.guardarConfigDeAvisos({ demoraMin: 999 }), /entre 0 y 240/);
    assert.throws(() => avisos.guardarConfigDeAvisos({ demoraMin: -5 }), /entre 0 y 240/);
  });
});

describe('cuando Meta no contesta bien', () => {
  it('un pedido no se frena porque el aviso falle', async () => {
    // Meta rechaza todo, incluidos los reintentos.
    respuestas = [{ estado: 400 }];
    const pedido = pedidoPorWhatsapp('5491155550010');

    // Lo que importa: esto no tira.
    const despues = advanceOrder(pedido.id, 'confirmado');
    await respirar();
    assert.equal(despues.status, 'confirmado', 'la cocina sigue trabajando igual');
    assert.equal(enviados.length, 0);
  });

  it('un 429 se reintenta: pasa cuando el local se llena, o sea cuando importa', async () => {
    respuestas = [{ estado: 429, retryAfter: '1' }];
    const pedido = pedidoPorWhatsapp('5491155550011');
    advanceOrder(pedido.id, 'confirmado');
    await esperarAvisos(1, 5000);

    assert.equal(enviados.length, 1, 'el segundo intento tiene que haber salido');
    assert.match(enviados[0]!.texto, /tomamos tu pedido/i);
  });

  it('un 500 también', async () => {
    respuestas = [{ estado: 500 }];
    const pedido = pedidoPorWhatsapp('5491155550012');
    advanceOrder(pedido.id, 'confirmado');
    await esperarAvisos(1, 5000);
    assert.equal(enviados.length, 1);
  });

  it('un 401 no: el token vencido no se arregla esperando', async () => {
    // Si se reintentara, serían tres llamadas fallidas por cada mensaje.
    respuestas = [{ estado: 401 }, { estado: 200 }];
    const pedido = pedidoPorWhatsapp('5491155550013');
    advanceOrder(pedido.id, 'confirmado');
    await new Promise((listo) => setTimeout(listo, 1200));

    assert.equal(enviados.length, 0, 'no se reintenta');
    // Y la segunda respuesta preparada quedó sin usar: prueba que no hubo un
    // segundo intento.
    assert.equal(respuestas.length, 1);
  });
});

describe('los textos', () => {
  const datos = { codigo: 'A12', servicio: 'local', demoraMin: 20 };

  it('no tutean de usted ni dicen "estimado cliente"', () => {
    for (const estado of ['confirmado', 'listo', 'cancelado'] as const) {
      const texto = avisos.textoDelAviso(estado, datos)!;
      assert.doesNotMatch(texto, /estimado|usted|su pedido nro/i, texto);
      assert.match(texto, /A12/, 'el código siempre va');
    }
  });

  it('los estados que no se avisan devuelven null', () => {
    assert.equal(avisos.textoDelAviso('en_preparacion', datos), null);
    assert.equal(avisos.textoDelAviso('entregado', datos), null);
    assert.equal(avisos.textoDelAviso('borrador', datos), null);
  });
});
