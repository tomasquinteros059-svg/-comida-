/**
 * QA 9 — El diagnóstico de WhatsApp: permisos y qué contesta.
 *
 * Es la ruta más nueva y la que menos pasó por manos. Lo que importa acá no es
 * que funcione con el dueño —eso ya lo probamos— sino que NO funcione con
 * cualquiera: el diagnóstico habla de credenciales, y aunque no las devuelve,
 * confirma cuáles están cargadas y cuáles no. Eso no es de la cocina.
 */
const BASE = 'http://127.0.0.1:3000/api';
const TOKEN = 'token-de-qa-bien-largo-32b';

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

const pedir = (ruta, cookie, metodo = 'POST') =>
  fetch(BASE + ruta, { method: metodo, headers: cookie ? { cookie } : {} });

// ── Quién puede pedirlo ─────────────────────────────────────────────────────
const sinNada = await pedir('/canales/whatsapp/probar', '');
caso('sin entrar, no se puede probar la conexión', sinNada.status === 401, `dio ${sinNada.status}`);

const cocina = await entrar('caro');
const conCocina = await pedir('/canales/whatsapp/probar', cocina);
caso('la cocina no puede probar la conexión', conCocina.status === 403, `dio ${conCocina.status}`);

const dueno = await entrar('ana');
const conDueno = await pedir('/canales/whatsapp/probar', dueno);
caso('el dueño sí puede', conDueno.status === 200, `dio ${conDueno.status}`);

// El estado del canal es la misma información: tiene que estar igual de cerrado.
const estadoCocina = await pedir('/canales/whatsapp', cocina, 'GET');
caso('la cocina tampoco ve el estado del canal', estadoCocina.status === 403, `dio ${estadoCocina.status}`);

// ── Qué contesta ────────────────────────────────────────────────────────────
const cuerpo = await conDueno.json();
caso('dice si está listo o no', typeof cuerpo.listo === 'boolean', JSON.stringify(cuerpo).slice(0, 120));
caso('devuelve pasos', Array.isArray(cuerpo.pasos) && cuerpo.pasos.length > 0, `${cuerpo.pasos?.length} pasos`);

// Sin credenciales tiene que frenar en el primer paso y no salir a internet.
caso(
  'sin credenciales no le pregunta nada a Meta',
  cuerpo.pasos.length === 1,
  `${cuerpo.pasos.length} pasos: ${cuerpo.pasos.map((p) => p.paso).join(' / ')}`,
);
caso('y dice qué falta, en castellano', /Falta/i.test(cuerpo.pasos[0].detalle), cuerpo.pasos[0].detalle);
caso('y dice dónde se arregla', /\.env/.test(cuerpo.pasos[0].arreglo ?? ''), cuerpo.pasos[0].arreglo);

// Lo que NO puede pasar: que el diagnóstico devuelva el token.
const texto = JSON.stringify(cuerpo);
caso(
  'no devuelve el valor de ninguna credencial',
  !/WHATSAPP_TOKEN=|Bearer |EAA[A-Za-z0-9]/.test(texto),
  texto.slice(0, 160),
);

// ── El webhook público sigue siendo público ─────────────────────────────────
// Es la otra mitad: Meta pega sin cookie y tiene que poder.
// Sin credenciales cargadas, un 403 es la respuesta CORRECTA: no hay palabra
// contra la cual comparar. Lo que hay que distinguir es quién contestó ese
// 403 —el guardia de sesión o el webhook—, porque si fuera el guardia, Meta
// nunca podría dar de alta el webhook por más credenciales que se carguen.
const verif = await fetch(
  `${BASE}/whatsapp?hub.mode=subscribe&hub.verify_token=cualquiera&hub.challenge=123`,
);
const textoVerif = await verif.text();
caso(
  'el webhook no está detrás del guardia de sesión (Meta no tiene cookie)',
  !/iniciar sesión|Necesitás/i.test(textoVerif) && verif.status !== 401,
  `dio ${verif.status}: ${textoVerif.slice(0, 60)}`,
);
caso(
  'con la palabra equivocada no da el visto bueno',
  textoVerif !== '123',
  `contestó "${textoVerif.slice(0, 40)}"`,
);

console.log('');
console.log(fallas.length ? `=== ${ok} OK, ${fallas.length} FALLAS ===` : `=== ${ok}/${ok} casos OK ===`);
for (const f of fallas) console.log(`  · ${f}`);
process.exit(fallas.length ? 1 : 0);
