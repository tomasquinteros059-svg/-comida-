/**
 * QA 8 — Las secciones nuevas, contra el servidor de verdad.
 *
 * Reorganizar una pantalla es mover botones de lugar, y ahí es donde se
 * rompen: un `onClick` que quedó colgado de un div que ya no está, un enlace
 * que apunta a una pantalla equivocada, un encabezado que en el teléfono tapa
 * lo que hay abajo. Nada de eso lo ve un test de unidad.
 */
import { chromium, devices } from 'playwright';

const BASE = 'http://127.0.0.1:3000';
let ok = 0;
const fallas = [];
const caso = (nombre, cumple, detalle = '') => {
  if (cumple) { ok += 1; console.log(`OK   ${nombre}`); }
  else { fallas.push(`${nombre}${detalle ? ` — ${detalle}` : ''}`); console.log(`FALLA ${nombre} — ${detalle}`); }
};

const entrar = async (p) => {
  await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(700);
  if (await p.locator('input[type="password"]').count()) {
    await p.locator('input').first().fill('ana');
    await p.locator('input[type="password"]').first().fill('clave-de-prueba');
    await p.getByRole('button', { name: 'Entrar', exact: true }).click();
    await p.waitForTimeout(1600);
  }
};

const b = await chromium.launch();

// ── Escritorio ──────────────────────────────────────────────────────────────
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
const errores = [];
p.on('pageerror', (e) => errores.push(String(e).split('\n')[0]));
await entrar(p);

await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

const titulos = await p.locator('.seccion-head h2').allTextContents();
caso('el panel tiene las cuatro secciones', titulos.length === 4, `encontré ${titulos.length}: ${titulos}`);
caso(
  'van en el orden de las preguntas del dueño',
  titulos.join(' | ') === 'Cómo viene el día | Para hacer hoy | Qué se vende y qué no | Cómo viene la semana',
  titulos.join(' | '),
);

// La sección que pide hacer algo va segunda, no al final.
caso('la sección que pide hacer algo no quedó abajo de todo', titulos[1] === 'Para hacer hoy', titulos[1]);

// Y está marcada: sin leerla se tiene que ver que es distinta.
const marcada = await p.locator('.seccion.hacer').count();
caso('está marcada al costado', marcada === 1, `${marcada} secciones marcadas`);
const borde = await p.locator('.seccion.hacer .card').first()
  .evaluate((n) => getComputedStyle(n).borderLeftWidth);
caso('la marca se dibuja de verdad', borde === '3px', `borde de ${borde}`);

// Cada sección tiene su renglón de para qué sirve.
const paras = await p.locator('.seccion-head p').count();
caso('cada sección dice para qué sirve', paras === 4, `${paras} de 4`);

// Los enlaces tienen que ir a donde dicen.
const reponer = await p.locator('.seccion.hacer a', { hasText: 'Reponer' }).getAttribute('href');
caso('"Reponer" va a Compras', reponer === '#/compras', reponer);
const verCarta = await p.locator('.seccion-head a', { hasText: 'Ver carta' }).getAttribute('href');
caso('"Ver carta" de la sección va a la Carta', verCarta === '#/carta', verCarta);

await p.locator('.seccion.hacer a', { hasText: 'Reponer' }).click();
await p.waitForTimeout(1200);
caso('y al tocarlo llega', p.url().endsWith('#/compras'), p.url());

// ── Stock: los botones siguen colgados de algo ──────────────────────────────
await p.goto(`${BASE}/#/stock`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);

const secStock = await p.locator('.seccion-head h2').allTextContents();
caso('stock quedó partido en dos', secStock.join(' | ') === 'Para reponer | Todo el inventario', secStock.join(' | '));

const botones = await p.locator('.seccion-head button').allTextContents();
caso(
  'los tres botones de reposición siguen en la pantalla',
  botones.some((t) => /Reponer normal/.test(t)) &&
    botones.some((t) => /Express/.test(t)) &&
    botones.some((t) => /Pedir ya/.test(t)),
  botones.join(' / '),
);

// El que importa: que al tocarlo pase algo. Antes vivía en otro div.
const pedidosAntes = await (await fetch(`${BASE}/api/procurement/purchase-orders`, {
  headers: { authorization: 'Bearer token-de-qa-bien-largo-32b' },
})).json().then((r) => (Array.isArray(r) ? r.length : (r.items?.length ?? 0))).catch(() => -1);

await p.locator('.seccion-head button', { hasText: 'Reponer normal' }).click();
await p.waitForTimeout(2500);

const pedidosDespues = await (await fetch(`${BASE}/api/procurement/purchase-orders`, {
  headers: { authorization: 'Bearer token-de-qa-bien-largo-32b' },
})).json().then((r) => (Array.isArray(r) ? r.length : (r.items?.length ?? 0))).catch(() => -1);

caso(
  'el botón de reponer sigue generando órdenes de compra',
  pedidosDespues > pedidosAntes,
  `antes ${pedidosAntes}, después ${pedidosDespues}`,
);

// Sin título repetido: la sección ya dice de qué se trata.
const repetido = await p.locator('.card-head h3', { hasText: 'Necesita reposición' }).count();
caso('no repite el título de la sección en la tarjeta', repetido === 0);

// ── Teléfono ────────────────────────────────────────────────────────────────
const ctel = await b.newContext({ ...devices['iPhone 13'] });
const tel = await ctel.newPage();
tel.on('pageerror', (e) => errores.push(`teléfono: ${String(e).split('\n')[0]}`));
await entrar(tel);
await tel.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await tel.waitForTimeout(1600);

const anchoTel = await tel.evaluate(() => ({
  scroll: document.documentElement.scrollWidth,
  ventana: window.innerWidth,
}));
caso('en el teléfono no se va de ancho', anchoTel.scroll <= anchoTel.ventana + 1, JSON.stringify(anchoTel));

const titulosTel = await tel.locator('.seccion-head h2').allTextContents();
caso('las secciones también se ven en el teléfono', titulosTel.length === 4, `${titulosTel.length}`);

// La columna que no entra: se esconde y el dato baja abajo del nombre.
const frenaColumna = await tel.locator('th.solo-ancho').first().isVisible().catch(() => false);
caso('la columna "Frena" no se muestra apretada en el teléfono', frenaColumna === false);
const frenaAbajo = await tel.locator('.solo-angosto').first().isVisible().catch(() => false);
caso('pero el dato sigue estando, abajo del nombre', frenaAbajo === true);

// Y nada de eso se pierde en el escritorio. La columna vive en el panel, no
// en stock: hay que volver antes de mirarla.
await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
const frenaEscritorio = await p.locator('th.solo-ancho').first().isVisible().catch(() => false);
caso('en el escritorio la columna vuelve', frenaEscritorio === true);

// Los dos grupos del menú se siguen distinguiendo sin el rótulo.
const bordes = await tel.evaluate(() =>
  [...document.querySelectorAll('.nav-grupo.arranca')].map((g) => getComputedStyle(g).borderLeftWidth),
);
caso(
  'el menú del teléfono sigue mostrando los dos grupos',
  bordes.length === 2 && bordes[0] === '0px' && bordes[1] === '1px',
  JSON.stringify(bordes),
);

caso('ninguna pantalla tiró un error', errores.length === 0, errores.join(' | '));

console.log('');
console.log(fallas.length ? `=== ${ok} OK, ${fallas.length} FALLAS ===` : `=== ${ok}/${ok} casos OK ===`);
for (const f of fallas) console.log(`  · ${f}`);
await b.close();
