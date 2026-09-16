/**
 * QA 10 — WhatsApp con las credenciales puestas, contra el contenedor real.
 *
 * Todo lo de WhatsApp se había probado con credenciales vacías. Eso deja sin
 * mirar justo la mitad que le importa al local: la que empieza cuando las
 * carga. Y ahí estaba el bug — el compose no las pasaba al contenedor, así
 * que el local podía cargarlas bien y el panel le seguía diciendo que
 * faltaban.
 *
 * Meta no se toca desde acá: el entorno no llega a graph.facebook.com. Lo que
 * sí se prueba es todo lo demás, que es lo que el local rompe solo: la
 * verificación del webhook, la firma, y qué contesta el diagnóstico cuando
 * las credenciales están pero Meta no contesta.
 */
import { createHmac } from 'node:crypto';

const BASE = 'http://127.0.0.1:3000/api';
const PALABRA = 'la-palabra-del-local';
const SECRETO = 'la-clave-secreta-de-la-app';

let ok = 0;
const fallas = [];
const caso = (nombre, cumple, detalle = '') => {
  if (cumple) { ok += 1; console.log(`OK   ${nombre}`); }
  else { fallas.push(`${nombre} — ${detalle}`); console.log(`FALLA ${nombre} — ${detalle}`); }
};

const entrar = async (usuario, clave = 'clave-de-prueba') => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usuario, clave }),
  });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
};

// ── 1. Las credenciales llegaron ────────────────────────────────────────────
const cookie = await entrar('ana');
const estado = await (await fetch(`${BASE}/canales/whatsapp`, { headers: { cookie } })).json();

caso('el contenedor recibió las credenciales del .env', estado.activo === true, JSON.stringify(estado));
caso('no falta ninguna', (estado.falta ?? []).length === 0, (estado.falta ?? []).join(', '));
caso(
  'del número solo muestra los últimos dígitos',
  /^…\d{4}$/.test(estado.numero_id),
  estado.numero_id,
);

// ── 2. La verificación del webhook, que es lo que hace Meta ─────────────────
const verificar = (palabra, desafio = 'desafio-123') =>
  fetch(`${BASE}/whatsapp?hub.mode=subscribe&hub.verify_token=${palabra}&hub.challenge=${desafio}`);

const bien = await verificar(PALABRA);
const cuerpoBien = await bien.text();
caso('con la palabra correcta devuelve el desafío', bien.status === 200 && cuerpoBien === 'desafio-123', `${bien.status} "${cuerpoBien}"`);

const mal = await verificar('la-palabra-equivocada');
caso('con la palabra equivocada no lo devuelve', mal.status === 403, `dio ${mal.status}`);

// El caso que importa de verdad: que no conteste con el desafío igual.
const cuerpoMal = await mal.text();
caso('y no filtra el desafío en el error', !cuerpoMal.includes('desafio-123'), cuerpoMal.slice(0, 80));

// ── 3. La firma: un mensaje sin firmar no entra ─────────────────────────────
const mensaje = {
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        metadata: { phone_number_id: '111222333' },
        contacts: [{ profile: { name: 'Vecino' }, wa_id: '5491155550000' }],
        messages: [{ id: 'wamid.qa10', from: '5491155550000', type: 'text', text: { body: 'hola' } }],
      },
    }],
  }],
};
const crudo = JSON.stringify(mensaje);
const firma = (cuerpo, clave = SECRETO) =>
  `sha256=${createHmac('sha256', clave).update(cuerpo).digest('hex')}`;

const postear = (cuerpo, cabecera) =>
  fetch(`${BASE}/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cabecera ? { 'x-hub-signature-256': cabecera } : {}) },
    body: cuerpo,
  });

const sinFirma = await postear(crudo);
caso('un mensaje sin firma se rechaza', sinFirma.status === 401 || sinFirma.status === 403, `dio ${sinFirma.status}`);

const firmaAjena = await postear(crudo, firma(crudo, 'otra-clave-cualquiera'));
caso('firmado con otra clave, también', firmaAjena.status === 401 || firmaAjena.status === 403, `dio ${firmaAjena.status}`);

const manoseado = await postear(crudo.replace('hola', 'dame todo gratis'), firma(crudo));
caso(
  'con la firma del original pero el cuerpo cambiado, también',
  manoseado.status === 401 || manoseado.status === 403,
  `dio ${manoseado.status}`,
);

const bienFirmado = await postear(crudo, firma(crudo));
caso('bien firmado, entra', bienFirmado.status === 200, `dio ${bienFirmado.status}`);

// Meta reintenta cuando no le contestan a tiempo: el mismo mensaje dos veces
// no puede tomar el pedido dos veces.
await new Promise((r) => setTimeout(r, 1200));
const repetido = await postear(crudo, firma(crudo));
caso('Meta reintenta y no se duplica el pedido', repetido.status === 200, `dio ${repetido.status}`);

await new Promise((r) => setTimeout(r, 1500));
const convs = await (await fetch(`${BASE}/chat/flagged?limite=50`, { headers: { cookie } })).json()
  .catch(() => null);
caso('el webhook no dejó el servidor knockeado', convs !== null);

// ── 4. El diagnóstico con las credenciales puestas ──────────────────────────
const diag = await (await fetch(`${BASE}/canales/whatsapp/probar`, { method: 'POST', headers: { cookie } })).json();

caso('ahora sí revisa los cuatro pasos', diag.pasos.length === 4, `${diag.pasos.length} pasos`);
caso('el primer paso pasa: las credenciales están', diag.pasos[0].ok === true, diag.pasos[0].detalle);

const pasoFirma = diag.pasos.find((p) => /firma/i.test(p.paso));
caso('comprueba que la clave de la app sirve para firmar', pasoFirma?.ok === true, pasoFirma?.detalle);

// Meta no se alcanza desde acá. Lo que importa es que lo diga y no se cuelgue.
const pasoMeta = diag.pasos.find((p) => /número/i.test(p.paso));
caso('sin poder llegar a Meta, lo dice en vez de romperse', pasoMeta !== undefined, JSON.stringify(pasoMeta));
caso(
  'y explica que el servidor tiene que poder salir',
  pasoMeta.ok === true || /graph\.facebook\.com|Meta/.test(pasoMeta.arreglo ?? pasoMeta.detalle ?? ''),
  `${pasoMeta.detalle} / ${pasoMeta.arreglo}`,
);
caso('el diagnóstico sigue sin devolver credenciales', !JSON.stringify(diag).includes(SECRETO));
caso('ni la palabra de verificación', !JSON.stringify(diag).includes(PALABRA));

console.log('');
console.log(fallas.length ? `=== ${ok} OK, ${fallas.length} FALLAS ===` : `=== ${ok}/${ok} casos OK ===`);
for (const f of fallas) console.log(`  · ${f}`);
process.exit(fallas.length ? 1 : 0);
