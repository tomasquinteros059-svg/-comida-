/**
 * QA — Conectar Mercado Pago desde el panel, y llegar a WhatsApp desde Chatbot.
 *
 * Los dos salieron de lo mismo: alguien parado en una pantalla que no tiene
 * cómo conectar lo que esa pantalla hace. Los cobros solo se podían configurar
 * por SSH, y desde "Chatbot" —la pantalla que se llama como el bot— no había
 * ninguna forma de llegar a conectarlo.
 *
 * Lo que importa, además de que funcione: que el token de Mercado Pago no
 * quede legible en la base, porque la base se respalda.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3000';
const TOKEN_MP = 'APP_USR-0000-elTokenDeProduccionDelLocal';
const CLAVE_WH = 'la-clave-del-webhook-de-mercadopago';

let ok = 0;
const fallas = [];
const caso = (n, cumple, detalle = '') => {
  if (cumple) { ok += 1; console.log(`OK   ${n}`); }
  else { fallas.push(`${n} — ${detalle}`); console.log(`FALLA ${n} — ${detalle}`); }
};

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1200 } });
const errores = [];
p.on('pageerror', (e) => errores.push(String(e).split('\n')[0]));

const ir = async (ruta) => {
  await p.goto(`${BASE}/#/${ruta}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
};

await ir('caja');
if (await p.locator('input[type="password"]').count()) {
  await p.locator('input').first().fill('ana');
  await p.locator('input[type="password"]').first().fill('clave-de-prueba');
  await p.getByRole('button', { name: 'Entrar', exact: true }).click();
  await p.waitForTimeout(1800);
  await ir('caja');
}

// ── 1. Desde Chatbot se llega a conectar WhatsApp ───────────────────────────
await ir('chat');
const textoChat = await p.locator('.content').innerText();
caso(
  'Chatbot avisa que es una consola de prueba',
  /consola de prueba/i.test(textoChat),
  textoChat.slice(0, 120).replace(/\n/g, ' | '),
);

const conectar = p.getByRole('link', { name: /Conectar WhatsApp/ });
caso('y ofrece conectarlo', (await conectar.count()) === 1);
if (await conectar.count()) {
  await conectar.click();
  await p.waitForTimeout(1800);
  caso('el botón lleva a donde se conecta', p.url().endsWith('#/bot'), p.url());
  const textoBot = await p.locator('.content').innerText();
  caso('y ahí están los campos', /Token de acceso/.test(textoBot));
}

// ── 2. Los cobros se cargan desde Caja ──────────────────────────────────────
await ir('caja');
const textoCaja = await p.locator('.content').innerText();
caso('Caja tiene la tarjeta de links de pago', /Links de pago/.test(textoCaja));
caso(
  'y dice que cobrar a mano funciona igual',
  /a mano/i.test(textoCaja),
  textoCaja.slice(0, 100).replace(/\n/g, ' | '),
);

const campos = p.locator('.card input:not([readonly]):not([type="file"])');
const cuantos = await campos.count();
caso('pide los tres datos', cuantos >= 3, `encontré ${cuantos}`);

await campos.nth(0).fill(TOKEN_MP);
await campos.nth(1).fill(CLAVE_WH);
await campos.nth(2).fill('https://pedidos.milocal.com.ar');
await p.getByRole('button', { name: 'Guardar y probar' }).click();
await p.waitForTimeout(4000);

const despues = await p.locator('.content').innerText();
caso(
  'después de guardar ya no dice que están apagados',
  !/links de pago están apagados/i.test(despues),
  despues.slice(0, 140).replace(/\n/g, ' | '),
);
caso('y probó la conexión solo', /Los datos están cargados/.test(despues), '');

// ── 3. El servidor los tomó, y no los devuelve ──────────────────────────────
const estado = await p.evaluate(async () =>
  (await fetch('/api/cobros/estado', { credentials: 'include' })).json(),
);
caso('el servidor dice que Mercado Pago está activo', estado.mercadopago?.activo === true, JSON.stringify(estado).slice(0, 140));
caso('y que salen del panel', estado.mercadopago?.origen?.accessToken === 'panel', JSON.stringify(estado.mercadopago?.origen));
caso(
  'el panel no devuelve el token',
  !JSON.stringify(estado).includes(TOKEN_MP),
  JSON.stringify(estado).slice(0, 140),
);

caso('ninguna pantalla tiró un error', errores.length === 0, errores.join(' | '));
await b.close();

// ── 4. En la base no quedó legible ──────────────────────────────────────────
const enLaBase = execFileSync('docker', [
  'compose', 'exec', '-T', 'comeia', 'node', '-e',
  `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH,{readonly:true});` +
  `console.log(db.prepare("SELECT value FROM settings WHERE key LIKE 'secreto.%'").all().map(r=>r.value).join('\\n'));`,
], { cwd: '/home/user/-comida-', encoding: 'utf8' });

caso('el token de Mercado Pago NO está legible en la base', !enLaBase.includes(TOKEN_MP), enLaBase.slice(0, 100));
caso('la clave del webhook tampoco', !enLaBase.includes(CLAVE_WH), enLaBase.slice(0, 100));

console.log('');
console.log(fallas.length ? `=== ${ok} OK, ${fallas.length} FALLAS ===` : `=== ${ok}/${ok} casos OK ===`);
for (const f of fallas) console.log(`  · ${f}`);
process.exit(fallas.length ? 1 : 0);
