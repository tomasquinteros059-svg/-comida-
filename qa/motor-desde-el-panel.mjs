/**
 * QA — Elegir y conectar el motor del bot desde el panel.
 *
 * Es lo primero que hay que conectar y lo último que estaba: sin modelo, el
 * bot entiende con reglas, y WhatsApp conectado solo hace que más gente lo vea
 * no entender.
 *
 * Lo que importa, además de que funcione: que la clave no quede legible en la
 * base, y que el panel nunca la devuelva.
 */
import { abrirNavegador } from './navegador.mjs';
import { execFileSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:3000';
const CLAVE = 'AIzaSyD-la-clave-de-gemini-del-local';

let ok = 0;
const fallas = [];
const caso = (n, cumple, d = '') => {
  if (cumple) { ok += 1; console.log(`OK   ${n}`); }
  else { fallas.push(`${n} — ${d}`); console.log(`FALLA ${n} — ${d}`); }
};

const b = await abrirNavegador();
const p = await b.newPage({ viewport: { width: 1440, height: 1200 } });
const errores = [];
p.on('pageerror', (e) => errores.push(String(e).split('\n')[0]));

const ir = async (r) => {
  await p.goto(`${BASE}/#/${r}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
};

await ir('bot');
if (await p.locator('input[type="password"]').count()) {
  await p.locator('input').first().fill('ana');
  await p.locator('input[type="password"]').first().fill('clave-de-prueba');
  await p.getByRole('button', { name: 'Entrar', exact: true }).click();
  await p.waitForTimeout(1800);
  await ir('bot');
}

// ── 1. Sin clave, lo dice y explica qué se pierde ───────────────────────────
const texto = await p.locator('.content').innerText();
caso('avisa que el bot está en modo básico', /modo básico/i.test(texto), texto.slice(0, 120).replace(/\n/g, ' | '));
caso(
  'y explica con un ejemplo qué no va a entender',
  /sacale la cebolla/i.test(texto),
  'sin un ejemplo concreto, "modo básico" no dice nada',
);
caso('ofrece las dos opciones', /Gemini/.test(texto) && /Claude/.test(texto));

// ── 2. Cargar la clave de Gemini ────────────────────────────────────────────
const campos = p.locator('.card input[type="password"]');
caso('pide una clave por proveedor', (await campos.count()) >= 2, `hay ${await campos.count()}`);

await campos.nth(0).fill(CLAVE);
// Por su etiqueta accesible, no por ser el primero: en esta pantalla hay dos
// "Guardar y probar" y cuál va primero depende del orden de las secciones.
await p.getByRole('button', { name: 'Guardar y probar el motor del bot' }).click();
await p.waitForTimeout(5000);

const despues = await p.locator('.content').innerText();
caso(
  'después de guardar deja de estar en modo básico',
  !/modo básico/i.test(despues),
  despues.slice(0, 150).replace(/\n/g, ' | '),
);
caso('y dice que está usando Gemini', /Gemini/.test(despues));

// ── 3. El servidor lo tomó, y no devuelve la clave ──────────────────────────
const estado = await p.evaluate(async () =>
  (await fetch('/api/canales/motor', { credentials: 'include' })).json(),
);
caso('el servidor dice que usa Gemini', estado.usando === 'gemini', JSON.stringify(estado));
caso('y que la clave salió del panel', estado.origen?.gemini === 'panel', JSON.stringify(estado.origen));
caso('el panel no devuelve la clave', !JSON.stringify(estado).includes(CLAVE), JSON.stringify(estado).slice(0, 120));

// ── 4. El motor del chat cambió de verdad ───────────────────────────────────
const salud = await p.evaluate(async () => (await fetch('/api/health')).json());
caso('el servidor ya no está en modo determinista', salud.engine === 'llm', JSON.stringify(salud));

caso('ninguna pantalla tiró un error', errores.length === 0, errores.join(' | '));
await b.close();

// ── 5. En la base no quedó legible ──────────────────────────────────────────
const enLaBase = execFileSync('docker', [
  'compose', 'exec', '-T', 'comeia', 'node', '-e',
  `const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH,{readonly:true});` +
  `console.log(db.prepare("SELECT value FROM settings WHERE key LIKE 'secreto.%'").all().map(r=>r.value).join('\\n'));`,
], { cwd: '/home/user/-comida-', encoding: 'utf8' });

caso('la clave de Gemini NO está legible en la base', !enLaBase.includes(CLAVE), enLaBase.slice(0, 100));
caso('y quedó cifrada', /v1:/.test(enLaBase));

console.log('');
console.log(fallas.length ? `=== ${ok} OK, ${fallas.length} FALLAS ===` : `=== ${ok}/${ok} casos OK ===`);
for (const f of fallas) console.log(`  · ${f}`);
process.exit(fallas.length ? 1 : 0);
