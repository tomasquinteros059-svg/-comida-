/**
 * QA 7 — La demo tiene que contestar lo mismo que el servidor de verdad.
 *
 * La pantalla de la Carta no abría en la demo porque `GET /menu` devolvía los
 * productos anidados adentro de cada categoría en vez de las tres listas que
 * devuelve la API real: `products` quedaba sin definir y React se caía entero.
 * Eso no lo agarra ningún test de unidad —los dos backends andaban bien por
 * separado— y en el navegador solo se ve si alguien entra a esa pantalla.
 *
 * Esto lo agarra: pide cada ruta que el panel pide de verdad a los dos lados y
 * compara la FORMA, no los valores. Los datos son distintos a propósito; lo
 * que no puede ser distinto son las claves y los tipos.
 */
import { responderDemo } from '../web/src/demo/servidor.js';

const BASE = 'http://127.0.0.1:3000/api';
const TOKEN = process.env.ADMIN_TOKEN ?? 'token-de-qa-bien-largo-32b';

/** Las rutas salen de buscar useApi() en el panel: son las que pide de verdad. */
const RUTAS = [
  '/dashboard',
  '/menu?all=1',
  '/menu/text',
  '/menu-performance?days=30',
  '/lagging?days=30',
  '/demand-gaps?days=30',
  '/knowledge',
  '/retencion',
  '/stock/alerts',
  '/stock/ingredients',
  '/orders/kitchen',
  '/orders/comandera/config',
  '/procurement/suppliers',
  '/cobros/estado',
  '/cobros/pendientes',
  '/cobros/caja',
  '/canales/whatsapp',
  '/usuarios',
  '/locales',
  '/chat/engine',
  '/chat/flagged?limite=20',
];

/**
 * La forma de un valor, como un texto comparable.
 *
 * De una lista se mira el primer elemento: en una lista homogénea alcanza, y
 * si viene vacía de un lado no se puede decir nada, así que no se compara.
 */
function forma(valor: unknown, profundidad = 0): string {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return valor.length ? `[${forma(valor[0], profundidad + 1)}]` : '[]';
  if (typeof valor === 'object') {
    if (profundidad > 3) return '{…}';
    const claves = Object.keys(valor as object).sort();
    return `{${claves.map((k) => `${k}:${forma((valor as never)[k], profundidad + 1)}`).join(',')}}`;
  }
  return typeof valor;
}

/** Las claves que faltan de un lado, con el camino donde faltan. */
function diferencias(real: unknown, demo: unknown, camino = ''): string[] {
  const salida: string[] = [];
  if (real === null || demo === null) return salida;

  if (Array.isArray(real) && Array.isArray(demo)) {
    // Con una lista vacía de cualquier lado no hay nada que comparar.
    if (real.length && demo.length) salida.push(...diferencias(real[0], demo[0], `${camino}[]`));
    return salida;
  }

  if (typeof real === 'object' && typeof demo === 'object') {
    const enReal = Object.keys(real as object);
    const enDemo = new Set(Object.keys(demo as object));
    for (const k of enReal) {
      if (!enDemo.has(k)) {
        salida.push(`${camino}.${k}: está en el servidor y no en la demo`);
        continue;
      }
      salida.push(...diferencias((real as never)[k], (demo as never)[k], `${camino}.${k}`));
    }
    return salida;
  }

  if (typeof real !== typeof demo) {
    salida.push(`${camino}: el servidor devuelve ${typeof real} y la demo ${typeof demo}`);
  }
  return salida;
}

let ok = 0;
const fallas: string[] = [];

for (const ruta of RUTAS) {
  let real: unknown;
  try {
    const res = await fetch(BASE + ruta, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) {
      fallas.push(`FALLA ${ruta}: el servidor contestó ${res.status}`);
      continue;
    }
    real = await res.json();
  } catch (err) {
    fallas.push(`FALLA ${ruta}: no se pudo pedir al servidor (${(err as Error).message})`);
    continue;
  }

  let demo: unknown;
  try {
    demo = await responderDemo('GET', ruta);
  } catch (err) {
    fallas.push(`FALLA ${ruta}: la demo tiró un error (${(err as Error).message})`);
    continue;
  }

  if (demo === undefined) {
    // No todas las rutas tienen por qué estar en la demo, pero si el panel la
    // pide y la demo no la contesta, la pantalla que la use no abre.
    fallas.push(`FALLA ${ruta}: el panel la pide y la demo no la contesta`);
    continue;
  }

  const difs = diferencias(real, demo);
  if (difs.length) {
    fallas.push(`FALLA ${ruta}:\n    ${difs.join('\n    ')}`);
    fallas.push(`       servidor: ${forma(real).slice(0, 220)}`);
    fallas.push(`       demo:     ${forma(demo).slice(0, 220)}`);
  } else {
    ok += 1;
  }
}

for (const f of fallas) console.log(f);
console.log(`=== ${ok}/${RUTAS.length} rutas con la misma forma en los dos backends ===`);
