import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('whatsapp-locales');
process.env.WHATSAPP_PHONE_NUMBER_ID = '100000000000001';
process.env.WHATSAPP_TOKEN = 'token-de-prueba';
process.env.WHATSAPP_VERIFY_TOKEN = 'la-palabra';
process.env.WHATSAPP_APP_SECRET = 'la-clave-de-la-app';

const SECRETO = 'la-clave-de-la-app';

const { closeDb, get } = await import('../db/index.js');
const locales = await import('../db/locales.js');
const { createApp } = await import('../index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');

let base: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
const enviados: Array<{ a: string; texto: string }> = [];

/**
 * Con varios locales, el webhook tiene que caer en la cocina correcta.
 *
 * Meta manda TODOS los webhooks a la misma dirección, así que el ruteo por
 * dominio —que es como entra todo lo demás al panel— no sirve: para Meta el
 * Host es siempre el mismo. Sin esto, dar de alta un segundo local hace que
 * los pedidos de los dos caigan en la cocina del primero, y nadie se entera
 * hasta que un cliente reclama un pedido que la otra sucursal ya cocinó.
 */
before(async () => {
  // listarLocales da de alta el principal si todavía no existe.
  locales.listarLocales();
  locales.actualizarLocal(locales.SLUG_POR_DEFECTO, { whatsapp_id: '100000000000001' });
  locales.crearLocal({ nombre: 'Sucursal Centro', slug: 'centro' });
  locales.actualizarLocal('centro', { whatsapp_id: '200000000000002' });

  // Cada local con su propia carta, para poder distinguir en cuál cayó.
  for (const slug of [locales.SLUG_POR_DEFECTO, 'centro']) {
    locales.enLocal(slug, () => {
      const cat = createCategory({ name: 'Empanadas' }).id;
      createProduct({ name: 'Empanada de carne', category_id: cat, price_cents: 150_000 });
    });
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const destino = String(url);
    if (destino.includes('graph.facebook.com')) {
      const cuerpo = JSON.parse(String(init?.body ?? '{}'));
      if (cuerpo.status === 'read') return new Response('{}', { status: 200 });
      enviados.push({ a: cuerpo.to, texto: cuerpo.text?.body ?? '' });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.ok' }] }), { status: 200 });
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
  locales.cerrarTodas();
  locales.cerrarRegistro();
});

const webhook = (opciones: { id: string; de: string; paraNumero: string; texto: string }) => ({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        metadata: { phone_number_id: opciones.paraNumero },
        contacts: [{ profile: { name: 'Vecino' }, wa_id: opciones.de }],
        messages: [{
          id: opciones.id,
          from: opciones.de,
          type: 'text',
          text: { body: opciones.texto },
        }],
      },
    }],
  }],
});

const mandar = async (cuerpo: unknown) => {
  const crudo = JSON.stringify(cuerpo);
  const res = await fetch(`${base}/api/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRETO).update(crudo).digest('hex')}`,
    },
    body: crudo,
  });
  // El webhook contesta enseguida y procesa después: hay que darle tiempo.
  await new Promise((listo) => setTimeout(listo, 400));
  return res;
};

/** Cuántas conversaciones tiene la base de ESE local. */
const conversacionesDe = (slug: string): number =>
  locales.enLocal(
    slug,
    () => get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')?.n ?? 0,
  );

describe('el webhook con varios locales', () => {
  it('el mensaje cae en el local dueño del número que lo recibió', async () => {
    const antesPrincipal = conversacionesDe(locales.SLUG_POR_DEFECTO);
    const antesCentro = conversacionesDe('centro');

    await mandar(webhook({
      id: 'wamid.centro.1',
      de: '5491155550001',
      paraNumero: '200000000000002',
      texto: 'hola',
    }));

    assert.equal(
      conversacionesDe('centro'),
      antesCentro + 1,
      'la conversación tiene que haber quedado en la base de la sucursal',
    );
    assert.equal(
      conversacionesDe(locales.SLUG_POR_DEFECTO),
      antesPrincipal,
      'y NO en la del principal: ese es exactamente el bug',
    );
  });

  it('un mensaje al otro número cae en el otro local', async () => {
    const antesCentro = conversacionesDe('centro');
    const antesPrincipal = conversacionesDe(locales.SLUG_POR_DEFECTO);

    await mandar(webhook({
      id: 'wamid.principal.1',
      de: '5491155550002',
      paraNumero: '100000000000001',
      texto: 'buenas',
    }));

    assert.equal(conversacionesDe(locales.SLUG_POR_DEFECTO), antesPrincipal + 1);
    assert.equal(conversacionesDe('centro'), antesCentro);
  });

  it('un número que ningún local tiene cargado no se pierde: va al principal', async () => {
    const antes = conversacionesDe(locales.SLUG_POR_DEFECTO);
    await mandar(webhook({
      id: 'wamid.desconocido.1',
      de: '5491155550003',
      paraNumero: '999999999999999',
      texto: 'hola?',
    }));
    assert.equal(
      conversacionesDe(locales.SLUG_POR_DEFECTO),
      antes + 1,
      'perder el mensaje sería peor que atenderlo en el local de siempre',
    );
  });

  it('y en todos los casos el cliente recibió una respuesta', () => {
    assert.ok(enviados.length >= 3, `se mandaron ${enviados.length} respuestas`);
    for (const e of enviados) assert.ok(e.texto.length > 0, 'ninguna respuesta puede ir vacía');
  });
});

describe('el número de WhatsApp de cada local', () => {
  it('dos locales no pueden compartir el mismo número', () => {
    assert.throws(
      () => locales.actualizarLocal('centro', { whatsapp_id: '100000000000001' }),
      /ya es del local/i,
      'los mensajes de uno caerían en la cocina del otro',
    );
  });

  it('se puede dejar vacío', () => {
    const sinNumero = locales.actualizarLocal('centro', { whatsapp_id: '' });
    assert.equal(sinNumero.whatsapp_id, '');
    // Y volver a ponerlo, que es lo que pasa cuando se corrige un tipeo.
    const conNumero = locales.actualizarLocal('centro', { whatsapp_id: '200000000000002' });
    assert.equal(conNumero.whatsapp_id, '200000000000002');
  });
});
