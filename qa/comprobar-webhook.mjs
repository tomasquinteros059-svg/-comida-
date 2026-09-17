/**
 * Comprueba, desde afuera, lo mismo que va a comprobar Meta.
 *
 * Meta da de alta el webhook una sola vez y, si algo no está, contesta
 * "The callback URL or verify token couldn't be validated" y nada más. No dice
 * cuál de las cinco cosas falló. Esto las prueba de a una y dice cuál.
 *
 * Uso:
 *   node qa/comprobar-webhook.mjs https://algo.trycloudflare.com
 *   node qa/comprobar-webhook.mjs https://pedidos.milocal.com.ar
 *
 * Correlo ANTES de pegar la dirección en Meta.
 */
import { createHmac } from 'node:crypto';

const base = (process.argv[2] ?? '').trim().replace(/\/+$/, '');
if (!base) {
  console.error('Uso: node qa/comprobar-webhook.mjs https://tu-direccion');
  process.exit(1);
}

let ok = 0;
const problemas = [];
const paso = (nombre, cumple, detalle = '', arreglo = '') => {
  if (cumple) {
    ok += 1;
    console.log(`  ✓ ${nombre}`);
  } else {
    problemas.push({ nombre, detalle, arreglo });
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
};

const pedir = async (ruta, opciones = {}) => {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), 15000);
  try {
    return await fetch(base + ruta, { ...opciones, signal: control.signal, redirect: 'manual' });
  } finally {
    clearTimeout(reloj);
  }
};

console.log(`\nRevisando ${base}\n`);

// ── 1. Que sea HTTPS ────────────────────────────────────────────────────────
// Meta no acepta http a secas, ni siquiera para probar.
paso(
  'La dirección es https',
  base.startsWith('https://'),
  base.startsWith('http://') ? 'es http, sin la s' : '',
  'Meta solo acepta https, con certificado válido. Ver deploy/tunel.sh.',
);

// ── 2. Que el servidor conteste ─────────────────────────────────────────────
let salud;
try {
  salud = await pedir('/api/health');
  paso('El servidor contesta desde afuera', salud.ok, `dio ${salud.status}`);
} catch (err) {
  paso(
    'El servidor contesta desde afuera',
    false,
    err.name === 'AbortError' ? 'no contestó en 15 segundos' : err.message,
    'Comprobá que comeIA esté levantado y que la dirección apunte ahí.',
  );
}

// ── 3. Que el webhook exista ────────────────────────────────────────────────
// Sin palabra de verificación, la respuesta correcta es 403: el webhook está y
// dice que no. Un 404 significa que la dirección está mal escrita.
let estadoWebhook = 0;
try {
  const r = await pedir('/api/whatsapp?hub.mode=subscribe&hub.verify_token=aver&hub.challenge=1');
  estadoWebhook = r.status;
  paso(
    'El webhook está en /api/whatsapp',
    r.status !== 404,
    r.status === 404 ? 'da 404: la dirección está mal' : `contesta ${r.status}`,
    'La dirección termina en /api/whatsapp, sin barra al final.',
  );
  paso(
    'No está tapado por el login',
    r.status !== 401 && !/iniciar sesión/i.test(await r.clone().text().catch(() => '')),
    r.status === 401 ? 'pide sesión, y Meta no tiene cookie' : '',
    'Si pide sesión, hay un proxy adelante pidiendo autenticación.',
  );
} catch (err) {
  paso('El webhook está en /api/whatsapp', false, err.message);
}

// ── 4. La palabra de verificación ───────────────────────────────────────────
// Es la prueba de fuego: Meta manda un desafío y hay que devolverlo TAL CUAL.
const palabra = process.env.WHATSAPP_VERIFY_TOKEN ?? process.argv[3];
if (!palabra) {
  console.log('\n  · Para probar la palabra de verificación, pasámela:');
  console.log('      node qa/comprobar-webhook.mjs ' + base + ' LA-PALABRA');
  console.log('    (o WHATSAPP_VERIFY_TOKEN=... adelante del comando)\n');
} else {
  const desafio = `desafio-${Math.random().toString(36).slice(2)}`;
  try {
    const r = await pedir(
      `/api/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(palabra)}&hub.challenge=${desafio}`,
    );
    const cuerpo = (await r.text()).trim();
    paso(
      'La palabra de verificación coincide',
      r.status === 200 && cuerpo === desafio,
      r.status !== 200
        ? `contestó ${r.status}`
        : `devolvió "${cuerpo.slice(0, 40)}" en vez del desafío`,
      'Tiene que ser la MISMA que cargaste en el panel. Es la que más se ' +
        'confunde: no es el token de acceso ni la clave de la app.',
    );
  } catch (err) {
    paso('La palabra de verificación coincide', false, err.message);
  }

  // ── 5. Que rechace una palabra equivocada ─────────────────────────────────
  // Si devolviera el desafío igual, cualquiera podría darse de alta.
  try {
    const r = await pedir(
      `/api/whatsapp?hub.mode=subscribe&hub.verify_token=la-que-no-es&hub.challenge=${desafio}`,
    );
    const cuerpo = (await r.text()).trim();
    paso(
      'Y rechaza una palabra equivocada',
      cuerpo !== desafio,
      'devolvió el desafío igual, sin comprobar nada',
    );
  } catch {
    paso('Y rechaza una palabra equivocada', false, 'no contestó');
  }
}

// ── 6. Que exija la firma ───────────────────────────────────────────────────
// Un mensaje sin firmar tiene que rebotar: es lo único que protege al webhook.
try {
  const r = await pedir('/api/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
  });
  paso(
    'Un mensaje sin firmar rebota',
    r.status === 401 || r.status === 403 || r.status === 503,
    `dio ${r.status}`,
    r.status === 200
      ? 'ATENCIÓN: entra cualquier cosa. Revisá que WHATSAPP_APP_SECRET esté cargada.'
      : '',
  );
} catch (err) {
  paso('Un mensaje sin firmar rebota', false, err.message);
}

// ── 7. Que la firma correcta entre ──────────────────────────────────────────
const clave = process.env.WHATSAPP_APP_SECRET;
if (clave) {
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'sent' }] } }] }],
  });
  try {
    const r = await pedir('/api/whatsapp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', clave).update(cuerpo).digest('hex')}`,
      },
      body: cuerpo,
    });
    paso(
      'Un mensaje bien firmado entra',
      r.status === 200,
      `dio ${r.status}`,
      'Si rebota, la clave de la app del panel no es la de Meta.',
    );
  } catch (err) {
    paso('Un mensaje bien firmado entra', false, err.message);
  }
}

// ── Resultado ───────────────────────────────────────────────────────────────
console.log('');
if (problemas.length === 0) {
  console.log(`  ${ok} de ${ok} — ya podés pegar esto en Meta:`);
  console.log(`      ${base}/api/whatsapp\n`);
  process.exit(0);
}

console.log(`  ${ok} bien, ${problemas.length} para arreglar:\n`);
for (const p of problemas) {
  console.log(`  · ${p.nombre}`);
  if (p.detalle) console.log(`    ${p.detalle}`);
  if (p.arreglo) console.log(`    → ${p.arreglo}`);
}
console.log('');
process.exit(1);
