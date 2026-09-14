import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('whatsapp');
process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
process.env.WHATSAPP_TOKEN = 'token-de-prueba';
process.env.WHATSAPP_VERIFY_TOKEN = 'la-palabra-secreta';
process.env.WHATSAPP_APP_SECRET = 'clave-de-la-app-de-prueba';

const SECRETO = 'clave-de-la-app-de-prueba';

const { closeDb, run, get } = await import('../db/index.js');
const { createApp } = await import('../index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const wa = await import('../domain/whatsapp.js');

let base: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
/** Lo que se le habría mandado a Meta, sin salir a internet. */
let enviados: Array<{ a: string; texto: string }> = [];

before(async () => {
  const categoria = createCategory({ name: 'Empanadas' }).id;
  createProduct({ name: 'Empanada de carne', category_id: categoria, price_cents: 150_000 });

  // Se intercepta fetch: la API de Meta no existe acá, y lo que importa es
  // qué se le habría mandado.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const destino = String(url);
    if (destino.includes('graph.facebook.com')) {
      const cuerpo = JSON.parse(String(init?.body ?? '{}'));
      enviados.push({ a: cuerpo.to, texto: cuerpo.text?.body ?? '' });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.enviado' }] }), { status: 200 });
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeDb();
});

beforeEach(() => {
  enviados = [];
});

const firmar = (cuerpo: string) => `sha256=${createHmac('sha256', SECRETO).update(cuerpo).digest('hex')}`;

const webhookDe = (texto: string, opciones: { id?: string; de?: string; nombre?: string } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '0',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            contacts: [{ wa_id: opciones.de ?? '5491155551234', profile: { name: opciones.nombre ?? 'Ana' } }],
            messages: [
              {
                from: opciones.de ?? '5491155551234',
                id: opciones.id ?? `wamid.${Math.random().toString(36).slice(2)}`,
                type: 'text',
                text: { body: texto },
              },
            ],
          },
          field: 'messages',
        },
      ],
    },
  ],
});

const mandarWebhook = (cuerpo: unknown, firma?: string) => {
  const crudo = JSON.stringify(cuerpo);
  return fetch(`${base}/api/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': firma ?? firmar(crudo) },
    body: crudo,
  });
};

describe('el alta del webhook', () => {
  it('devuelve el desafío si la palabra coincide', async () => {
    const res = await fetch(
      `${base}/api/whatsapp?hub.mode=subscribe&hub.verify_token=la-palabra-secreta&hub.challenge=1234567`,
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '1234567', 'Meta espera el desafío tal cual, en texto plano');
  });

  it('con la palabra equivocada no da de alta nada', async () => {
    const res = await fetch(
      `${base}/api/whatsapp?hub.mode=subscribe&hub.verify_token=otra-cosa&hub.challenge=1234567`,
    );
    assert.equal(res.status, 403);
  });
});

describe('la firma del webhook', () => {
  it('sin firma no entra', async () => {
    const res = await fetch(`${base}/api/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookDe('hola')),
    });
    assert.equal(res.status, 401);
  });

  it('con una firma inventada tampoco', async () => {
    const res = await mandarWebhook(webhookDe('hola'), 'sha256=0000000000');
    assert.equal(res.status, 401);
  });

  it('firmada con otra clave, tampoco', async () => {
    const cuerpo = webhookDe('hola');
    const otra = `sha256=${createHmac('sha256', 'otra-clave').update(JSON.stringify(cuerpo)).digest('hex')}`;
    assert.equal((await mandarWebhook(cuerpo, otra)).status, 401);
  });

  it('se firma el cuerpo crudo, no el objeto vuelto a armar', () => {
    // Los mismos datos con otro orden de claves dan otros bytes: si se firmara
    // el objeto parseado, esto coincidiría y no tiene que coincidir.
    const crudo = '{"a":1,"b":2}';
    assert.ok(wa.firmaValida(crudo, firmar(crudo)));
    assert.ok(!wa.firmaValida('{"b":2,"a":1}', firmar(crudo)));
  });

  it('con la firma correcta entra', async () => {
    const res = await mandarWebhook(webhookDe('hola'));
    assert.equal(res.status, 200);
  });
});

describe('un cliente pidiendo por WhatsApp', () => {
  it('el bot le contesta al número que escribió', async () => {
    await mandarWebhook(webhookDe('hola, quiero dos empanadas de carne'));
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(enviados.length, 1, 'tenía que contestar una vez');
    assert.equal(enviados[0]!.a, '5491155551234');
    assert.match(enviados[0]!.texto, /[Ee]mpanada/);
  });

  it('el segundo mensaje sigue la misma conversación', async () => {
    const de = '5491199998888';
    await mandarWebhook(webhookDe('quiero una empanada de carne', { de }));
    await new Promise((r) => setTimeout(r, 500));
    await mandarWebhook(webhookDe('nada más, confirmo', { de }));
    await new Promise((r) => setTimeout(r, 500));

    const cuantas = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE external_id = ?', [de])!.n;
    assert.equal(cuantas, 1, 'el que agrega algo está siguiendo su pedido, no empezando otro');
    assert.match(enviados[enviados.length - 1]!.texto, /pedido|número/i);
  });

  it('dos números distintos son dos conversaciones', async () => {
    await mandarWebhook(webhookDe('hola', { de: '5491111111111' }));
    await mandarWebhook(webhookDe('hola', { de: '5492222222222' }));
    await new Promise((r) => setTimeout(r, 600));

    const a = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE external_id = ?', ['5491111111111'])!.n;
    const b = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE external_id = ?', ['5492222222222'])!.n;
    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  it('guarda el nombre del perfil', async () => {
    await mandarWebhook(webhookDe('hola', { de: '5493333333333', nombre: 'Beto Pérez' }));
    await new Promise((r) => setTimeout(r, 400));
    const fila = get<{ customer_name: string }>(
      'SELECT customer_name FROM conversations WHERE external_id = ?',
      ['5493333333333'],
    );
    assert.equal(fila?.customer_name, 'Beto Pérez');
  });
});

describe('los reintentos de Meta', () => {
  it('el mismo mensaje dos veces se procesa una sola', async () => {
    const id = 'wamid.el-mismo-de-siempre';
    const cuerpo = webhookDe('quiero una empanada de carne', { id, de: '5494444444444' });

    await mandarWebhook(cuerpo);
    await new Promise((r) => setTimeout(r, 500));
    const despuesDelPrimero = enviados.length;

    await mandarWebhook(cuerpo);
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(enviados.length, despuesDelPrimero, 'un reintento no puede volver a pedir');
    const mensajes = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE conversation_id =
         (SELECT id FROM conversations WHERE external_id = '5494444444444')
       AND role = 'user'`,
    )!.n;
    assert.equal(mensajes, 1, 'el mensaje tiene que estar una sola vez en la conversación');
  });

  it('marcar como visto avisa si ya estaba', () => {
    assert.equal(wa.marcarComoVisto('wamid.nuevo'), true);
    assert.equal(wa.marcarComoVisto('wamid.nuevo'), false);
  });

  it('la limpieza borra los viejos y deja los de ahora', () => {
    run("INSERT INTO mensajes_vistos (id, created_at) VALUES ('viejo', datetime('now','-30 days'))");
    run("INSERT INTO mensajes_vistos (id, created_at) VALUES ('reciente', datetime('now'))");
    wa.limpiarMensajesVistos();
    assert.ok(!get('SELECT id FROM mensajes_vistos WHERE id = ?', ['viejo']));
    assert.ok(get('SELECT id FROM mensajes_vistos WHERE id = ?', ['reciente']));
  });
});

describe('lo que llega y no es un pedido', () => {
  it('un audio o una foto no rompen nada', async () => {
    const cuerpo = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '549555', profile: { name: 'X' } }],
                messages: [{ from: '549555', id: 'wamid.audio', type: 'audio', audio: { id: 'x' } }],
              },
            },
          ],
        },
      ],
    };
    const res = await mandarWebhook(cuerpo);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { recibidos: 0 });
  });

  it('un aviso de entrega sin mensajes tampoco', async () => {
    const cuerpo = { entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'delivered' }] } }] }] };
    assert.equal((await mandarWebhook(cuerpo)).status, 200);
  });

  it('un cuerpo con forma rara devuelve cero, no un error', () => {
    assert.deepEqual(wa.mensajesDelWebhook(null), []);
    assert.deepEqual(wa.mensajesDelWebhook({}), []);
    assert.deepEqual(wa.mensajesDelWebhook({ entry: 'no es una lista' }), []);
  });
});

describe('mensajes largos', () => {
  it('se parten por renglón, no al medio de una línea', () => {
    const carta = Array.from({ length: 300 }, (_, i) => `Producto ${i} .... $10.000`).join('\n');
    const partes = wa.partirTexto(carta, 4000);
    assert.ok(partes.length > 1, 'una carta larga no entra en un solo mensaje');
    for (const p of partes) assert.ok(p.length <= 4000);
    assert.ok(partes.every((p) => !p.startsWith('.')), 'ningún pedazo empieza a mitad de renglón');
    assert.equal(partes.join('\n'), carta, 'junto todo tiene que dar lo mismo');
  });

  it('un texto corto queda en un solo mensaje', () => {
    assert.deepEqual(wa.partirTexto('hola', 4000), ['hola']);
  });
});

describe('la configuración', () => {
  it('dice qué falta en castellano', () => {
    assert.equal(wa.whatsappActivo(), true);
    assert.deepEqual(wa.loQueFaltaDeWhatsapp(), []);
  });

  it('sin credenciales no se hace el vivo', () => {
    const guardado = process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_TOKEN;
    assert.equal(wa.whatsappActivo(), false);
    assert.match(wa.loQueFaltaDeWhatsapp().join(' '), /token/i);
    process.env.WHATSAPP_TOKEN = guardado;
  });
});
