import { devices } from 'playwright';
import { abrirNavegador } from './navegador.mjs';

/**
 * La demo en un solo archivo, abierta como la abre quien la recibe.
 *
 * Es el archivo que se manda por WhatsApp o por mail para mostrar el panel
 * sin instalar nada. No lo cubría ninguna suite: las otras prueban el
 * servidor, y esta no tiene servidor —todo el backend está simulado adentro
 * del mismo HTML—.
 *
 * Se abre con file:// a propósito, que es como llega: si algo del empaquetado
 * quedó pidiendo una dirección absoluta, acá se ve y en un servidor local no.
 */

const ARCHIVO = new URL('../web/dist-unico/comeIA-demo.html', import.meta.url).href;

const res = [];
const ok = (c, v, d = '') => { res.push(v); console.log(`${v ? 'OK  ' : 'FALLA'} ${c}${d ? ` — ${d}` : ''}`); };

const PANTALLAS = ['Panel', 'Cocina', 'Caja', 'Chatbot', 'Carta', 'Stock', 'Compras', 'Usuarios'];

const br = await abrirNavegador();

for (const [modo, vp] of [['escritorio', { viewport: { width: 1440, height: 950 } }], ['teléfono', devices['iPhone 13']]]) {
  const ctx = await br.newContext(vp);
  const page = await ctx.newPage();
  const problemas = [];
  page.on('pageerror', (e) => problemas.push(`excepción: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problemas.push(`consola: ${m.text()}`); });

  await page.goto(ARCHIVO, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  ok(`[${modo}] abre sin pedir usuario`, await page.$('.sidebar') !== null,
    'la demo entra sola; si pide clave, no sirve para mostrarla');

  for (const nombre of PANTALLAS) {
    const enlace = page.locator('.sidebar a, .sidebar button').filter({ hasText: nombre }).first();
    if (!(await enlace.count())) { ok(`[${modo}] ${nombre} está en el menú`, false); continue; }
    await enlace.click().catch(() => {});
    await page.waitForTimeout(450);
    // Que haya pintado algo: una pantalla en blanco es el síntoma de que
    // la demo contesta distinto que el servidor y React se cayó.
    const pintó = await page.evaluate(() => (document.querySelector('.content')?.innerText ?? '').trim().length > 40);
    ok(`[${modo}] ${nombre} muestra contenido`, pintó);
  }

  // El teléfono es donde se mira: que no haya que arrastrar de costado.
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  ok(`[${modo}] no desborda a lo ancho`, m.s <= m.w + 1, JSON.stringify(m));

  ok(`[${modo}] sin errores de consola`, problemas.length === 0, problemas.slice(0, 3).join(' | ') || 'ninguno');
  await ctx.close();
}

await br.close();
const buenos = res.filter(Boolean).length;
console.log(`\n=== ${buenos}/${res.length} casos OK ===`);
process.exit(buenos === res.length ? 0 : 1);
