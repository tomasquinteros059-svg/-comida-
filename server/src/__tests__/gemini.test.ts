import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('gemini');
process.env.ADMIN_TOKEN = 'un-token-de-administracion-bien-largo';
delete process.env.ANTHROPIC_API_KEY;
process.env.GEMINI_API_KEY = 'AIza-la-clave-de-prueba';
process.env.GEMINI_MODEL = 'gemini-2.5-flash';

const { closeDb } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { createConversation } = await import('../domain/conversations.js');
const { chat } = await import('../chat/engine.js');
const gemini = await import('../chat/gemini.js');
const { proveedorDeChat, hasLLM } = await import('../config.js');
const secretos = await import('../domain/secretos.js');

/** Lo que Gemini va a contestar, en orden. Cada llamada consume uno. */
let respuestas: unknown[] = [];
/** Lo que se le mandó a Gemini, para mirarlo. */
let pedidos: Array<{ url: string; cuerpo: any }> = [];

before(() => {
  const cat = createCategory({ name: 'Empanadas' }).id;
  createProduct({ name: 'Empanada de carne', category_id: cat, price_cents: 150_000 });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const destino = String(url);
    if (destino.includes('generativelanguage.googleapis.com')) {
      pedidos.push({ url: destino, cuerpo: JSON.parse(String(init?.body ?? '{}')) });
      const siguiente = respuestas.shift();
      if (siguiente === undefined) return new Response('{}', { status: 500 });
      if (siguiente instanceof Response) return siguiente;
      return new Response(JSON.stringify(siguiente), { status: 200 });
    }
    return originalFetch(url as never, init);
  }) as typeof fetch;
});

after(() => closeDb());

beforeEach(() => {
  respuestas = [];
  pedidos = [];
});

/** Una respuesta de Gemini con texto. */
const conTexto = (texto: string) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: texto }] } }],
});

/** Una respuesta de Gemini pidiendo una herramienta. */
const conHerramienta = (name: string, args: Record<string, unknown>) => ({
  candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args } }] } }],
});

describe('elegir el motor', () => {
  it('con clave de Gemini y sin la de Anthropic, usa Gemini', () => {
    assert.equal(proveedorDeChat(), 'gemini');
    assert.equal(hasLLM(), true);
  });

  it('con las dos, gana Anthropic: una instalación que andaba no cambia de motor', () => {
    // Las del .env se leen al arrancar; las del panel son vivas. Se carga una
    // de Anthropic por el panel y tiene que ganarle a la de Gemini del .env.
    secretos.guardarSecreto(secretos.SECRETO_DE_CHAT.anthropic, 'sk-ant-la-de-siempre');
    assert.equal(proveedorDeChat(), 'anthropic');

    secretos.guardarSecreto(secretos.SECRETO_DE_CHAT.anthropic, '');
    assert.equal(proveedorDeChat(), 'gemini');
  });

  it('la clave cargada desde el panel vale igual que la del entorno', () => {
    // Sin nada guardado y sin nada en el entorno no habría motor; con la del
    // panel alcanza, y sin reiniciar el servidor.
    secretos.guardarSecreto(secretos.SECRETO_DE_CHAT.gemini, 'AIza-cargada-desde-el-panel');
    assert.equal(proveedorDeChat(), 'gemini');
    assert.equal(hasLLM(), true);
    secretos.guardarSecreto(secretos.SECRETO_DE_CHAT.gemini, '');
  });
});

describe('el esquema de las herramientas', () => {
  it('saca lo que Gemini no entiende', () => {
    const limpio = gemini.limpiarEsquema({
      type: 'object',
      $schema: 'http://json-schema.org/draft-07/schema#',
      additionalProperties: false,
      properties: {
        texto: { type: 'string', description: 'algo', default: 'x' },
        cuantos: { type: 'integer', minimum: 1 },
      },
      required: ['texto'],
    }) as Record<string, any>;

    // Gemini RECHAZA la llamada entera si encuentra una clave que no conoce,
    // en vez de ignorarla, y el error no dice cuál fue.
    assert.equal(limpio.$schema, undefined);
    assert.equal(limpio.additionalProperties, undefined);
    assert.equal(limpio.properties.texto.default, undefined);
    assert.equal(limpio.properties.cuantos.minimum, undefined);

    // Y deja lo que sí sirve.
    assert.equal(limpio.type, 'object');
    assert.deepEqual(limpio.required, ['texto']);
    assert.equal(limpio.properties.texto.description, 'algo');
    assert.equal(limpio.properties.cuantos.type, 'integer');
  });

  it('limpia también adentro de los arrays', () => {
    const limpio = gemini.limpiarEsquema({
      type: 'array',
      items: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
    }) as Record<string, any>;
    assert.equal(limpio.items.additionalProperties, undefined);
    assert.equal(limpio.items.properties.a.type, 'string');
  });
});

describe('atender un mensaje con Gemini', () => {
  it('contesta texto', async () => {
    respuestas = [conTexto('Hola! Tenemos empanadas de carne.')];
    const conv = createConversation({ channel: 'web' }).id;
    const turno = await chat(conv, 'hola, qué tienen?');

    assert.equal(turno.engine, 'llm');
    assert.match(turno.reply, /empanadas/i);
    assert.equal(pedidos.length, 1);
  });

  it('el modelo va en la dirección y la clave en la cabecera, no en la URL', async () => {
    respuestas = [conTexto('hola')];
    await chat(createConversation({ channel: 'web' }).id, 'hola');

    assert.match(pedidos[0]!.url, /models\/gemini-2\.5-flash:generateContent/);
    // En la URL la clave queda en los registros del proxy y del servidor.
    assert.ok(!pedidos[0]!.url.includes('AIza'), pedidos[0]!.url);
  });

  it('manda las herramientas como functionDeclarations', async () => {
    respuestas = [conTexto('hola')];
    await chat(createConversation({ channel: 'web' }).id, 'hola');

    const tools = pedidos[0]!.cuerpo.tools;
    assert.ok(Array.isArray(tools) && tools[0].functionDeclarations?.length > 0);
    const nombres = tools[0].functionDeclarations.map((f: any) => f.name);
    assert.ok(nombres.includes('buscar_en_carta'), nombres.join(', '));
    // Ninguna declaración puede llevar claves que Gemini rechaza.
    const crudo = JSON.stringify(tools);
    assert.ok(!crudo.includes('additionalProperties'), 'quedó additionalProperties');
    assert.ok(!crudo.includes('$schema'), 'quedó $schema');
  });

  it('corre la herramienta que pide y le devuelve el resultado', async () => {
    respuestas = [
      conHerramienta('buscar_en_carta', { texto: 'empanada' }),
      conTexto('Tenemos empanada de carne a $1.500.'),
    ];
    const turno = await chat(createConversation({ channel: 'web' }).id, 'tenés empanadas?');

    assert.equal(turno.trace.length, 1);
    assert.equal(turno.trace[0]!.tool, 'buscar_en_carta');
    assert.match(turno.reply, /empanada de carne/i);

    // La segunda llamada tiene que llevar la respuesta de la herramienta.
    const segundo = pedidos[1]!.cuerpo.contents;
    const ultima = segundo[segundo.length - 1];
    assert.equal(ultima.role, 'user');
    assert.equal(
      ultima.parts[0].functionResponse.name,
      'buscar_en_carta',
      'Gemini aparea por NOMBRE: con otro no encuentra la respuesta',
    );
    // Siempre un objeto: con un array suelto Gemini rechaza el turno.
    assert.equal(typeof ultima.parts[0].functionResponse.response, 'object');
    assert.ok(!Array.isArray(ultima.parts[0].functionResponse.response));
  });

  it('el rol del modelo se manda como "model", no como "assistant"', async () => {
    respuestas = [
      conHerramienta('buscar_en_carta', { texto: 'empanada' }),
      conTexto('listo'),
    ];
    await chat(createConversation({ channel: 'web' }).id, 'hola');

    const roles = pedidos[1]!.cuerpo.contents.map((c: any) => c.role);
    assert.ok(roles.includes('model'), roles.join(', '));
    assert.ok(!roles.includes('assistant'), 'Gemini no conoce ese rol');
  });

  it('si Gemini falla, contesta el determinista en vez de dejar al cliente sin nada', async () => {
    respuestas = [new Response('{"error":{"message":"uf"}}', { status: 500 })];
    const turno = await chat(createConversation({ channel: 'web' }).id, 'hola');

    assert.ok(turno.reply.length > 0, 'el cliente tiene que recibir algo');
    assert.equal(turno.engine, 'llm', 'sigue siendo el turno del modelo, contestó el respaldo');
  });

  it('un mensaje bloqueado por Google tampoco deja al cliente sin respuesta', async () => {
    respuestas = [{ promptFeedback: { blockReason: 'SAFETY' } }];
    const turno = await chat(createConversation({ channel: 'web' }).id, 'hola');
    assert.ok(turno.reply.length > 0);
  });

  it('no se queda dando vueltas para siempre si el modelo pide herramientas sin parar', async () => {
    respuestas = Array.from({ length: 20 }, () => conHerramienta('buscar_en_carta', { texto: 'x' }));
    const turno = await chat(createConversation({ channel: 'web' }).id, 'hola');

    assert.ok(pedidos.length <= 6, `hizo ${pedidos.length} llamadas`);
    assert.match(turno.reply, /de nuevo|simple/i);
  });
});

describe('probar la conexión con Gemini', () => {
  it('lista los modelos que esa clave puede usar', async () => {
    respuestas = [
      {
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      },
    ];
    const { listo, pasos } = await gemini.probarGemini();

    assert.equal(listo, true, JSON.stringify(pasos));
    assert.equal(pasos.length, 3);
    // El de embeddings no sirve para chatear: no tiene que contarse.
    assert.match(pasos[1]!.detalle, /1 modelos/);
  });

  it('si el modelo configurado no existe, dice cuáles sí', async () => {
    // La clave tiene otros modelos, no el configurado. Los nombres de Gemini
    // cambian seguido, así que el error útil es la LISTA de los que sí están.
    respuestas = [
      {
        models: [
          { name: 'models/gemini-3-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] },
        ],
      },
    ];
    const { listo, pasos } = await gemini.probarGemini();
    const paso = pasos.find((p) => p.paso.includes('existe'))!;

    assert.equal(listo, false);
    assert.equal(paso.ok, false);
    assert.match(paso.arreglo ?? '', /gemini-3-pro/, 'tiene que decir cuáles sirven');
  });

  it('una clave que Google rechaza se explica, no se traga', async () => {
    respuestas = [new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 })];
    const { listo, pasos } = await gemini.probarGemini();

    assert.equal(listo, false);
    // Hay dos pasos que hablan de la clave: el que importa es el de Google.
    const paso = pasos.find((p) => p.paso.includes('Google'))!;
    assert.match(paso.detalle + (paso.arreglo ?? ''), /API key not valid|aistudio/i);
  });

  it('el diagnóstico nunca devuelve la clave', async () => {
    respuestas = [{ models: [] }];
    const { pasos } = await gemini.probarGemini();
    assert.ok(!JSON.stringify(pasos).includes('AIza'), JSON.stringify(pasos).slice(0, 120));
  });
});
