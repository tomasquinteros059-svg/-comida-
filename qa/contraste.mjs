import { devices } from 'playwright';
import { abrirNavegador } from './navegador.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

/**
 * Contraste medido sobre la pantalla, no sobre los tokens.
 *
 * Existe por un error propio. Al cambiar el fondo a color papa frita medí los
 * pares de variables CSS —acento sobre fondo, texto sobre fondo— y uno dio
 * 3.99, abajo del mínimo. Estuve por oscurecer el dorado entero para arreglarlo.
 *
 * No hacía falta: el acento NUNCA se apoya sobre el fondo. Vive en la barra
 * lateral, que es blanca. El par existía en mi planilla y no en el producto.
 *
 * Al revés también pasa: dos tokens que miden bien se pueden terminar
 * encontrando en una tarjeta adentro de otra tarjeta, y ahí el fondo efectivo
 * no es ninguno de los dos.
 *
 * Así que esto recorre el texto que de verdad se ve, le busca el fondo real
 * —subiendo por los padres hasta encontrar uno que no sea transparente, que es
 * lo que hace el ojo— y mide eso. Lo que no está en pantalla no se mide.
 */

const RAIZ = new URL('../web/dist-demo/', import.meta.url).pathname;
const MIMES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.ico': 'image/x-icon',
};

const servidor = createServer(async (req, res) => {
  const pedido = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  for (const camino of [join(RAIZ, pedido), join(RAIZ, 'index.html')]) {
    try {
      const cuerpo = await readFile(camino);
      res.writeHead(200, { 'content-type': MIMES[extname(camino)] ?? 'application/octet-stream' });
      return res.end(cuerpo);
    } catch { /* probamos el que sigue */ }
  }
  res.writeHead(404).end();
});
await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${servidor.address().port}`;

/**
 * Lo que corre adentro del navegador.
 *
 * El fondo efectivo no es `background-color` del elemento: casi todo es
 * `transparent` y lo que se ve es el de algún padre. Hay que subir hasta
 * encontrar uno opaco, igual que compone el navegador.
 */
const MEDIR = `(() => {
  const aLineal = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const leer = (css) => {
    const m = css.match(/[\\d.]+/g);
    if (!m) return null;
    const [r, g, b, a] = m.map(Number);
    return { r, g, b, a: a === undefined ? 1 : a };
  };
  const luz = ({ r, g, b }) =>
    0.2126 * aLineal(r / 255) + 0.7152 * aLineal(g / 255) + 0.0722 * aLineal(b / 255);
  const razon = (a, b) => {
    const [x, y] = [luz(a), luz(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // Un color con alfa sobre otro: lo que ve el ojo.
  const encimar = (frente, atras) => ({
    r: frente.r * frente.a + atras.r * (1 - frente.a),
    g: frente.g * frente.a + atras.g * (1 - frente.a),
    b: frente.b * frente.a + atras.b * (1 - frente.a),
    a: 1,
  });

  const fondoDe = (el) => {
    const pila = [];
    for (let n = el; n; n = n.parentElement) {
      const c = leer(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      pila.push(c);
      if (c.a === 1) break;
    }
    if (!pila.length) return { r: 255, g: 255, b: 255, a: 1 };
    let fondo = pila.pop();
    while (pila.length) fondo = encimar(pila.pop(), fondo);
    return fondo;
  };

  const salida = [];
  const vistos = new Set();
  for (const el of document.querySelectorAll('body *')) {
    // Solo el texto propio: si se contara el de los hijos, cada contenedor
    // mediría con su fondo y no con el de la línea que se lee.
    const propio = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    if (!propio) continue;

    const caja = el.getBoundingClientRect();
    if (caja.width < 1 || caja.height < 1) continue;
    const e = getComputedStyle(el);
    if (e.visibility === 'hidden' || e.display === 'none' || Number(e.opacity) < 0.1) continue;

    const frente = leer(e.color);
    if (!frente) continue;
    const fondo = fondoDe(el);
    const color = frente.a < 1 ? encimar(frente, fondo) : frente;

    const px = parseFloat(e.fontSize);
    const grueso = Number(e.fontWeight) >= 700 || /bold/.test(e.fontWeight);
    // WCAG: 3:1 alcanza para texto grande (24px, o 18.66px en negrita).
    const grande = px >= 24 || (grueso && px >= 18.66);
    const minimo = grande ? 3 : 4.5;
    const r = razon(color, fondo);

    const quien = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
    const llave = quien + '|' + Math.round(r * 100);
    if (vistos.has(llave)) continue;
    vistos.add(llave);

    salida.push({
      quien,
      texto: propio.slice(0, 44),
      razon: Math.round(r * 100) / 100,
      minimo,
      px: Math.round(px * 10) / 10,
      pasa: r >= minimo,
    });
  }
  return salida;
})()`;

const br = await abrirNavegador();

/** Por dónde pasear: toda pantalla que tenga texto propio. */
const PANTALLAS = [
  ['Panel', 'Panel'], ['Chatbot', 'Chatbot'], ['Carta', 'Carta'], ['Pedidos', 'Pedidos'],
  ['Caja', 'Caja'], ['Stock', 'Stock'], ['Cocina', 'Cocina'], ['Equipo', 'Equipo'],
];

const fallas = [];
let medidos = 0;

for (const [modo, esquema] of [['claro', 'light'], ['oscuro', 'dark']]) {
  for (const [ancho, vp] of [['escritorio', { viewport: { width: 1440, height: 1000 } }], ['teléfono', devices['iPhone 13']]]) {
    const ctx = await br.newContext({ ...vp, colorScheme: esquema });
    const page = await ctx.newPage();
    await page.goto(B, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    for (const [nombre, texto] of PANTALLAS) {
      const enlace = page.locator(`.sidebar a, .sidebar button`).filter({ hasText: texto }).first();
      if (await enlace.count()) {
        await enlace.click().catch(() => {});
        await page.waitForTimeout(500);
      }
      const filas = await page.evaluate(MEDIR);
      medidos += filas.length;
      for (const f of filas.filter((x) => !x.pasa)) {
        fallas.push({ ...f, donde: `${modo}/${ancho}/${nombre}` });
      }
    }
    await ctx.close();
  }
}

await br.close();
servidor.close();

console.log(`\nMedidas ${medidos} combinaciones de texto y fondo sobre la pantalla.\n`);

if (!fallas.length) {
  console.log('Todo el texto visible llega al mínimo de la WCAG.');
  process.exit(0);
}

// Una misma clase falla en varias pantallas; lo que hay que arreglar es la
// clase, no cada aparición.
const porClase = new Map();
for (const f of fallas) {
  const previo = porClase.get(f.quien);
  if (!previo || f.razon < previo.razon) porClase.set(f.quien, f);
}

console.log(`${porClase.size} selectores abajo del mínimo:\n`);
for (const f of [...porClase.values()].sort((a, b) => a.razon - b.razon)) {
  console.log(`  ${f.razon} (mínimo ${f.minimo}, ${f.px}px) ${f.quien}`);
  console.log(`      "${f.texto}" — ${f.donde}`);
}
process.exit(1);
