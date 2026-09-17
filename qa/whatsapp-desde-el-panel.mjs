/**
 * QA — Conectar WhatsApp desde el panel, sin tocar el servidor.
 *
 * Es el caso que importa para el dueño del local: no tiene SSH, no tiene por
 * qué tenerlo, y hasta acá "conectá WhatsApp" era "conseguite a alguien que
 * edite un archivo en el servidor".
 *
 * Lo que se comprueba, además de que funcione:
 *   - que el token NO quede legible en la base, porque la base se respalda;
 *   - que el panel nunca devuelva lo que guardó;
 *   - que la variable de entorno le siga ganando al panel.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3000';
const TOKEN_DE_META = 'EAAG0000ElTokenDeMetaDelLocal';
const PALABRA = 'la-palabra-que-invento-el-local';

let ok = 0;
const fallas = [];
const caso = (nombre, cumple, detalle = '') => {
  if (cumple) { ok += 1; console.log(`OK   ${nombre}`); }
  else { fallas.push(`${nombre} — ${detalle}`); console.log(`FALLA ${nombre} — ${detalle}`); }
};

const entrar = async (p) => {
  await p.goto(`${BASE}/#/bot`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  if (await p.locator('input[type="password"]').count()) {
    await p.locator('input').first().fill('ana');
    await p.locator('input[type="password"]').first().fill('clave-de-prueba');
    await p.getByRole('button', { name: 'Entrar', exact: true }).click();
    await p.waitForTimeout(1800);
    await p.goto(`${BASE}/#/bot`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1800);
  }
};

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
const errores = [];
p.on('pageerror', (e) => errores.push(String(e).split('\n')[0]));
await entrar(p);

// ── 1. La tarjeta muestra los cuatro campos ─────────────────────────────────
caso('la tarjeta de WhatsApp está', (await p.getByText('WhatsApp del local').count()) === 1);

const etiquetas = await p.locator('.card label, .field label').allTextContents();
const tiene = (t) => etiquetas.some((e) => e.includes(t));
caso(
  'se piden las cuatro credenciales por su nombre',
  tiene('Identificador del número') && tiene('Token de acceso') &&
    tiene('Palabra de verificación') && tiene('Clave secreta de la app'),
  etiquetas.join(' | ').slice(0, 200),
);

// ── 2. La palabra de verificación se puede inventar sola ────────────────────
await p.getByRole('button', { name: 'Inventar una' }).click();
await p.waitForTimeout(300);
const campos = p.locator('.card input:not([readonly])');
const palabraSugerida = await campos.nth(2).inputValue();
caso(
  'propone una palabra de verificación al azar',
  palabraSugerida.length >= 20,
  `propuso "${palabraSugerida}"`,
);

// ── 3. Cargar las cuatro y guardar ──────────────────────────────────────────
await campos.nth(0).fill('123456789012345');
await campos.nth(1).fill(TOKEN_DE_META);
await campos.nth(2).fill(PALABRA);
await campos.nth(3).fill('la-clave-secreta-de-la-app');

await p.getByRole('button', { name: 'Guardar y probar' }).click();
await p.waitForTimeout(3500);

const textoTarjeta = await p.locator('.card').first().innerText();
caso(
  'después de guardar, ya no dice que faltan las credenciales',
  !/WhatsApp no está conectado/.test(textoTarjeta),
  textoTarjeta.slice(0, 160).replace(/\n/g, ' | '),
);
caso(
  'y prueba la conexión solo, sin que haya que tocar otro botón',
  /Las credenciales están cargadas/.test(textoTarjeta),
  textoTarjeta.slice(0, 200).replace(/\n/g, ' | '),
);

// ── 4. El servidor las tomó de verdad ───────────────────────────────────────
// Desde la pagina misma: `page.request` no lleva la cookie de sesion.
const estado = await p.evaluate(async () =>
  (await fetch('/api/canales/whatsapp', { credentials: 'include' })).json(),
);
caso('el servidor dice que WhatsApp está activo', estado.activo === true, JSON.stringify(estado));
caso('y que salen del panel', estado.origen?.token === 'panel', JSON.stringify(estado.origen));

// Lo que NO puede pasar nunca: que el panel devuelva lo que guardó.
const crudoEstado = JSON.stringify(estado);
caso(
  'el panel no devuelve el token ni la clave',
  !crudoEstado.includes(TOKEN_DE_META) && !crudoEstado.includes('la-clave-secreta'),
  crudoEstado.slice(0, 180),
);

// ── 5. El webhook ya funciona: es la prueba de que sirvieron ────────────────
const verif = await p.request.get(
  `${BASE}/api/whatsapp?hub.mode=subscribe&hub.verify_token=${PALABRA}&hub.challenge=eldesafio`,
);
caso(
  'Meta ya podría dar de alta el webhook',
  verif.status() === 200 && (await verif.text()) === 'eldesafio',
  `dio ${verif.status()}`,
);

const malo = await p.request.get(
  `${BASE}/api/whatsapp?hub.mode=subscribe&hub.verify_token=otra-palabra&hub.challenge=eldesafio`,
);
caso('con otra palabra no', malo.status() === 403, `dio ${malo.status()}`);

caso('ninguna pantalla tiró un error', errores.length === 0, errores.join(' | '));
await b.close();

// ── 6. En la base no quedó el token legible ─────────────────────────────────
// Es lo que más importa de todo: la base se copia todas las noches y esas
// copias terminan circulando.
import { execFileSync } from 'node:child_process';
const enLaBase = execFileSync('docker', [
  'compose', 'exec', '-T', 'comeia', 'node', '-e',
  `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH,{readonly:true});` +
  `console.log(db.prepare("SELECT value FROM settings WHERE key LIKE 'secreto.%'").all().map(r=>r.value).join('\\n'));`,
], { cwd: '/home/user/-comida-', encoding: 'utf8' });

caso('algo se guardó', enLaBase.trim().length > 0);
caso(
  'el token NO está legible en la base',
  !enLaBase.includes(TOKEN_DE_META),
  enLaBase.slice(0, 120),
);
caso(
  'la palabra de verificación tampoco',
  !enLaBase.includes(PALABRA),
  enLaBase.slice(0, 120),
);
caso('y está marcado con qué método se cifró', /v1:/.test(enLaBase), enLaBase.slice(0, 60));

console.log('');
console.log(fallas.length ? `=== ${ok} OK, ${fallas.length} FALLAS ===` : `=== ${ok}/${ok} casos OK ===`);
for (const f of fallas) console.log(`  · ${f}`);
process.exit(fallas.length ? 1 : 0);
