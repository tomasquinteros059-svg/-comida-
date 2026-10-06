import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Abrir el navegador, en un solo lugar.
 *
 * Existe por dos problemas que convivían. Cuatro comprobaciones
 * —`secciones`, `whatsapp-desde-el-panel`, `cobros-desde-el-panel` y
 * `motor-desde-el-panel`— llamaban a `chromium.launch()` a secas y, donde el
 * navegador no está en la ruta por defecto, **se morían sin imprimir nada**.
 * No fallaban: no decían nada. Quien las corría veía el título de la sección,
 * ninguna línea abajo, y seguía de largo creyendo que no había qué reportar.
 *
 * Las otras cinco sí abrían, pero con la ruta escrita a mano y con el número
 * de versión adentro (`chromium-1194`). Eso anda hasta que se actualiza el
 * navegador, y ahí se rompen las cinco juntas por una razón que no tiene nada
 * que ver con el producto.
 *
 * Acá se resuelve una vez: lo que diga CHROMIUM, si no lo que Playwright
 * encuentre solo, si no cualquier chromium instalado, sin importar la versión.
 */

/** El ejecutable, o null para que lo resuelva Playwright. */
function buscarEjecutable() {
  if (process.env.CHROMIUM && existsSync(process.env.CHROMIUM)) return process.env.CHROMIUM;

  const raiz = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!raiz || !existsSync(raiz)) return null;

  // Cualquier carpeta chromium-*, la más nueva primero. Sin fijar la versión:
  // es justo lo que rompía antes. Ordenado por número y no como texto, que
  // pondría "chromium-999" arriba de "chromium-1194".
  const carpetas = readdirSync(raiz)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));

  for (const carpeta of carpetas) {
    const camino = join(raiz, carpeta, 'chrome-linux', 'chrome');
    if (existsSync(camino)) return camino;
  }
  return null;
}

/**
 * Abre el navegador o explica por qué no pudo.
 *
 * Tira con un mensaje en castellano en vez de dejar morir el script en
 * silencio: una comprobación que no corre tiene que notarse igual que una que
 * falla.
 */
export async function abrirNavegador(opciones = {}) {
  const executablePath = buscarEjecutable();
  try {
    return await chromium.launch(executablePath ? { ...opciones, executablePath } : opciones);
  } catch (err) {
    throw new Error(
      'No se pudo abrir el navegador para esta comprobación.\n' +
        `  probé: ${executablePath ?? 'la ruta por defecto de playwright'}\n` +
        `  el error fue: ${err instanceof Error ? err.message.split('\n')[0] : err}\n` +
        '  arreglo: npx playwright install chromium, o poné CHROMIUM=/ruta/al/chrome',
    );
  }
}
