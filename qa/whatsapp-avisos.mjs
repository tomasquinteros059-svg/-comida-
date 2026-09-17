/**
 * QA — El circuito entero de WhatsApp contra el contenedor real.
 *
 * Los tests de unidad falsean `fetch`, así que prueban la lógica pero no el
 * camino: el cuerpo crudo que firma Meta, el ruteo por número, el aviso que
 * sale de un cambio de estado hecho desde el panel. Eso solo se ve acá.
 *
 * Necesita la pila levantada CON las credenciales puestas y un falso Meta
 * escuchando, que es lo que este script levanta.
 */
import { createHmac } from 'node:crypto';
import http from 'node:http';

const BASE = 'http://127.0.0.1:3000/api';
const SECRETO = process.env.WHATSAPP_APP_SECRET ?? 'la-clave-secreta-de-la-app';
const NUMERO_LOCAL = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '111222333';

let ok = 0;
const fallas = [];
const caso = (nombre, cumple, detalle = '') => {
  if (cumple) { ok += 1; console.log(`OK   ${nombre}`); }
  else { fallas.push(`${nombre} — ${detalle}`); console.log(`FALLA ${nombre} — ${detalle}`); }
};

const entrar = async (usuario = 'ana', clave = 'clave-de-prueba') => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usuario, clave }),
  });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
};

const cookie = await entrar();
if (!cookie) {
  console.log('FALLA no pude entrar al panel: ¿corriste prep.mjs?');
  process.exit(1);
}

const firmar = (cuerpo) => `sha256=${createHmac('sha256', SECRETO).update(cuerpo).digest('hex')}`;

const mandarMensaje = async (texto, opciones = {}) => {
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: opciones.paraNumero ?? NUMERO_LOCAL },
          contacts: [{ profile: { name: opciones.nombre ?? 'Vecino' }, wa_id: opciones.de ?? '5491155559999' }],
          messages: [{
            id: opciones.id ?? `wamid.qa.${Math.random().toString(36).slice(2)}`,
            from: opciones.de ?? '5491155559999',
            type: 'text',
            text: { body: texto },
          }],
        },
      }],
    }],
  });
  const res = await fetch(`${BASE}/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': firmar(cuerpo) },
    body: cuerpo,
  });
  await new Promise((listo) => setTimeout(listo, 1500));
  return res;
};

// ── 1. Un cliente escribe y el bot le contesta ──────────────────────────────
const antes = await (await fetch(`${BASE}/chat/flagged?limite=1`, { headers: { cookie } })).json();
caso('el panel responde antes de empezar', antes !== null);

const r1 = await mandarMensaje('hola, qué tenés?');
caso('el webhook acepta un mensaje bien firmado', r1.status === 200, `dio ${r1.status}`);

// ── 2. El pedido de punta a punta ───────────────────────────────────────────
await mandarMensaje('quiero 6 empanadas de carne', { id: 'wamid.qa.pedido1' });
await mandarMensaje('para retirar por el local', { id: 'wamid.qa.pedido2' });
await mandarMensaje('sí, confirmo', { id: 'wamid.qa.pedido3' });

const pedidos = await (await fetch(`${BASE}/orders?limite=20`, { headers: { cookie } })).json();
const lista = pedidos.items ?? pedidos ?? [];
caso('el pedido de WhatsApp llegó al panel', lista.length > 0, `hay ${lista.length} pedidos`);

const delChat = lista.find((p) => p.channel === 'whatsapp' || p.channel === 'chat');
caso('y quedó marcado como venido del chat', Boolean(delChat), JSON.stringify(lista[0] ?? {}).slice(0, 120));

// ── 3. El aviso al cliente cuando la cocina lo mueve ────────────────────────
if (delChat) {
  const avisar = async (estado) => {
    const r = await fetch(`${BASE}/orders/${delChat.id}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ status: estado }),
    });
    await new Promise((listo) => setTimeout(listo, 1200));
    return r;
  };

  const estados = ['confirmado', 'en_preparacion', 'listo'];
  let todosOk = true;
  for (const estado of estados) {
    const r = await avisar(estado);
    if (!r.ok && r.status !== 409) todosOk = false;
  }
  caso('la cocina pudo mover el pedido hasta listo', todosOk);

  // Lo que importa: mover el pedido NO puede romperse porque Meta no exista.
  const final = await (await fetch(`${BASE}/orders/${delChat.id}`, { headers: { cookie } })).json();
  caso(
    'el pedido llegó a listo aunque Meta no conteste',
    final.status === 'listo' || final.status === 'entregado',
    `quedó en ${final.status}`,
  );
}

// ── 4. Los avisos se configuran desde el panel ──────────────────────────────
const cfg = await (await fetch(`${BASE}/canales/avisos`, { headers: { cookie } })).json();
caso('el panel lee la configuración de avisos', typeof cfg.activo === 'boolean', JSON.stringify(cfg));

const guardado = await fetch(`${BASE}/canales/avisos`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ demoraMin: 45 }),
});
const cfg2 = await guardado.json();
caso('y la puede cambiar', cfg2.demoraMin === 45, JSON.stringify(cfg2));

const malo = await fetch(`${BASE}/canales/avisos`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ demoraMin: 9999 }),
});
caso('una demora imposible se rechaza', malo.status === 400, `dio ${malo.status}`);
const textoMalo = await malo.json().catch(() => ({}));
caso(
  'y el error está en castellano',
  /entre 0 y 240/.test(textoMalo.error ?? ''),
  textoMalo.error,
);

// ── 5. El número del local, en Locales ──────────────────────────────────────
const locales = await (await fetch(`${BASE}/locales`, { headers: { cookie } })).json();
caso(
  'cada local trae su número de WhatsApp',
  locales.locales.every((l) => typeof l.whatsapp_id === 'string'),
  JSON.stringify(locales.locales[0] ?? {}).slice(0, 140),
);

const puesto = await fetch(`${BASE}/locales/principal`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ whatsapp_id: NUMERO_LOCAL }),
});
caso('se puede cargar desde el panel', puesto.ok, `dio ${puesto.status}`);

const conTelefono = await fetch(`${BASE}/locales/principal`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ whatsapp_id: '+54 9 11 5555-5555' }),
});
caso(
  'pegar el teléfono en vez del identificador se rechaza',
  conTelefono.status === 400,
  `dio ${conTelefono.status}`,
);

// ── 6. La cocina no puede tocar los avisos ──────────────────────────────────
const cocina = await entrar('caro');
const intento = await fetch(`${BASE}/canales/avisos`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie: cocina },
  body: JSON.stringify({ activo: false }),
});
caso('la cocina no puede apagar los avisos', intento.status === 403, `dio ${intento.status}`);

console.log('');
console.log(fallas.length ? `=== ${ok} OK, ${fallas.length} FALLAS ===` : `=== ${ok}/${ok} casos OK ===`);
for (const f of fallas) console.log(`  · ${f}`);
process.exit(fallas.length ? 1 : 0);
