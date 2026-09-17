const B = 'http://127.0.0.1:3000';
const T = 'token-de-qa-bien-largo-32b';
const res = [];
const ok = (c, v, d = '') => { res.push(v); console.log(`${v ? 'OK  ' : 'FALLA'} ${c}${d ? ` — ${d}` : ''}`); };

const p = async (r, { m = 'GET', b, cookie, token } = {}) => {
  const s = await fetch(B + r, {
    method: m,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  const t = await s.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: s.status, json: j, cookie: (s.headers.get('set-cookie') ?? '').split(';')[0] };
};

const entrar = async (usuario, clave) => (await p('/api/auth/login', { m: 'POST', b: { usuario, clave } })).cookie;

// ── Cambio de clave propio ──────────────────────────────────────────────────
const caro = await entrar('caro', 'clave-de-prueba');
ok('1.1 cocina entra con su clave', !!caro);

const mal = await p('/api/auth/clave', { m: 'POST', cookie: caro, b: { actual: 'no-es-esta', nueva: 'clave-nueva-larga' } });
ok('1.2 pide la clave actual aunque la sesión esté abierta', mal.status === 401, `status ${mal.status}`);

const corta = await p('/api/auth/clave', { m: 'POST', cookie: caro, b: { actual: 'clave-de-prueba', nueva: 'corta' } });
ok('1.3 no acepta una clave nueva corta', corta.status === 400, JSON.stringify(corta.json).slice(0, 110));

const otroDispositivo = await entrar('caro', 'clave-de-prueba');
const cambio = await p('/api/auth/clave', { m: 'POST', cookie: caro, b: { actual: 'clave-de-prueba', nueva: 'la-clave-de-caro-2' } });
ok('1.4 cambia la clave', cambio.status === 200, `status ${cambio.status}`);
ok('1.5 y devuelve una sesión nueva para este dispositivo', cambio.cookie.startsWith('comeia_sesion='));

const sigueAdentro = await p('/api/orders/kitchen', { cookie: cambio.cookie });
ok('1.6 el que la cambió NO queda afuera', sigueAdentro.status === 200, `status ${sigueAdentro.status}`);

const elOtro = await p('/api/orders/kitchen', { cookie: otroDispositivo });
ok('1.7 el otro dispositivo sí se cierra', elOtro.status === 401, `status ${elOtro.status}`);

const vieja = await p('/api/auth/login', { m: 'POST', b: { usuario: 'caro', clave: 'clave-de-prueba' } });
const nueva = await p('/api/auth/login', { m: 'POST', b: { usuario: 'caro', clave: 'la-clave-de-caro-2' } });
ok('1.8 la clave vieja ya no sirve y la nueva sí', vieja.status === 401 && nueva.status === 200, `vieja ${vieja.status} · nueva ${nueva.status}`);

const conToken = await p('/api/auth/clave', { m: 'POST', token: T, b: { actual: 'x', nueva: 'clave-nueva-larga' } });
ok('1.9 con el token maestro explica por qué no', conToken.status === 409 && /token maestro/.test(conToken.json.error), `status ${conToken.status}`);

const sinSesion = await p('/api/auth/clave', { m: 'POST', b: { actual: 'x', nueva: 'clave-nueva-larga' } });
ok('1.10 sin sesión no se puede', sinSesion.status === 401, `status ${sinSesion.status}`);

// ── Mensajes en castellano ──────────────────────────────────────────────────
const ana = await entrar('beto', 'clave-de-prueba');
ok('2.0 hay sesión para probar los mensajes', !!ana);
const ingles = /must contain|Required|Expected|Invalid enum|String must|Number must|received/;

const casos = [
  ['producto sin nombre', '/api/menu/products', { name: '' }],
  ['categoría con un número por nombre', '/api/menu/categories', { name: 42 }],
  ['falta un dato obligatorio', '/api/menu/products', {}],
];
for (const [titulo, ruta, cuerpo] of casos) {
  const r = await p(ruta, { m: 'POST', cookie: ana, b: cuerpo });
  const textos = (r.json.issues ?? []).map((i) => i.detalle).join(' | ');
  ok(`2 ${titulo}`, r.status === 400 && textos && !ingles.test(textos), textos.slice(0, 120));
}

const ing = (await p('/api/stock/ingredients', { cookie: ana })).json;
const moz = ing.find((i) => i.name === 'Mozzarella');
const rEnum = await p(`/api/stock/ingredients/${moz.id}/movements`, { m: 'POST', cookie: ana, b: { delta: 1, reason: 'lo-que-sea' } });
const det = rEnum.json.issues?.[0]?.detalle ?? '';
ok('2 una opción inválida dice cuáles valen', !ingles.test(det) && /merma/.test(det), det.slice(0, 130));

const rFecha = await p('/api/sales?from=ayer', { cookie: ana });
ok('2 una fecha mal formada explica el formato', rFecha.status === 400 && !ingles.test(JSON.stringify(rFecha.json)), JSON.stringify(rFecha.json).slice(0, 120));

const rDias = await p('/api/lagging?days=hola', { cookie: ana });
ok('2 un parámetro de reporte inválido no sale en inglés', rDias.status === 400 && !ingles.test(JSON.stringify(rDias.json)), JSON.stringify(rDias.json).slice(0, 120));

console.log(`\n=== ${res.filter(Boolean).length}/${res.length} casos OK ===`);
