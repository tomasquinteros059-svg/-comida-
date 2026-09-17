const B = 'http://127.0.0.1:3000';
const T = 'token-de-qa-bien-largo-32b';
const res = [];
const ok = (c, v, d = '') => { res.push(v); console.log(`${v ? 'OK  ' : 'FALLA'} ${c}${d ? ` — ${d}` : ''}`); };

const p = async (r, { m = 'GET', b, cookie } = {}) => {
  const s = await fetch(B + r, {
    method: m,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : { authorization: `Bearer ${T}` }) },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  const t = await s.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: s.status, json: j, cookie: (s.headers.get('set-cookie') ?? '').split(';')[0] };
};

// ── 1. Paginación ───────────────────────────────────────────────────────────
const p1 = await p('/api/orders?limite=10&desde=0');
ok('1.1 el listado viene paginado con total', p1.status === 200 && Array.isArray(p1.json.items) && typeof p1.json.total === 'number',
   `${p1.json.items?.length} de ${p1.json.total}`);
ok('1.2 trae exactamente el límite pedido', p1.json.items.length === 10, `vinieron ${p1.json.items.length}`);
ok('1.3 el total es mayor que la página', p1.json.total > 10 && p1.json.hay_mas === true, `total ${p1.json.total}`);

const p2 = await p('/api/orders?limite=10&desde=10');
const ids1 = new Set(p1.json.items.map((o) => o.id));
const solapados = p2.json.items.filter((o) => ids1.has(o.id));
ok('1.4 la segunda página no repite la primera', solapados.length === 0, `${solapados.length} repetidos`);

// Recorrer todo y comprobar que no se pierde ninguno
const todos = new Set();
for (let d = 0; d < p1.json.total; d += 50) {
  const pg = await p(`/api/orders?limite=50&desde=${d}`);
  for (const o of pg.json.items) todos.add(o.id);
}
ok('1.5 recorriendo todas las páginas salen todos', todos.size === p1.json.total, `${todos.size} de ${p1.json.total}`);

const lejos = await p(`/api/orders?limite=10&desde=99999`);
ok('1.6 pasarse de largo devuelve vacío, no error', lejos.status === 200 && lejos.json.items.length === 0 && lejos.json.hay_mas === false, `status ${lejos.status}`);

const malo = await p('/api/orders?limite=0');
ok('1.7 un límite inválido se rechaza en castellano', malo.status === 400 && !/must|Expected|Number/.test(JSON.stringify(malo.json)), JSON.stringify(malo.json).slice(0, 110));

const enorme = await p('/api/orders?limite=99999');
ok('1.8 no deja pedir un límite gigante', enorme.status === 400, `status ${enorme.status}`);

for (const ruta of ['/api/chat/conversations', '/api/chat/flagged', '/api/procurement/purchase-orders', '/api/stock/movements', '/api/usuarios/auditoria']) {
  const r = await p(`${ruta}?limite=5`);
  ok(`1.9 ${ruta} pagina`, r.status === 200 && Array.isArray(r.json.items) && typeof r.json.total === 'number', `status ${r.status}`);
}

// ── 2. Bitácora con filtros ─────────────────────────────────────────────────
const ana = await p('/api/auth/login', { m: 'POST', b: { usuario: 'ana', clave: 'clave-de-prueba' } });
const cookieAna = ana.cookie;
await p('/api/menu/categories', { m: 'POST', cookie: cookieAna, b: { name: 'Sanguches' } });
await p('/api/menu/categories', { m: 'POST', cookie: cookieAna, b: { name: 'Bebidas frías' } });

const beto = await p('/api/auth/login', { m: 'POST', b: { usuario: 'beto', clave: 'clave-de-prueba' } });
await p('/api/menu/categories', { m: 'POST', cookie: beto.cookie, b: { name: 'Wraps' } });

const todo = await p('/api/usuarios/auditoria?limite=100', { cookie: cookieAna });
ok('2.1 la bitácora trae quiénes figuran', Array.isArray(todo.json.quienes) && todo.json.quienes.length >= 2, JSON.stringify(todo.json.quienes));

const soloAna = await p('/api/usuarios/auditoria?limite=100&quien=Ana', { cookie: cookieAna });
ok('2.2 filtra por persona', soloAna.json.items.every((f) => f.user_name === 'Ana') && soloAna.json.total < todo.json.total,
   `${soloAna.json.total} de ${todo.json.total}`);

const porTexto = await p('/api/usuarios/auditoria?limite=100&texto=Sanguches', { cookie: cookieAna });
ok('2.3 busca por lo que se tocó', porTexto.json.total === 1 && porTexto.json.items[0].target === 'Sanguches', `total ${porTexto.json.total}`);

const hoy = new Date().toISOString().slice(0, 10);
const porFecha = await p(`/api/usuarios/auditoria?limite=100&desde_fecha=${hoy}&hasta_fecha=${hoy}`, { cookie: cookieAna });
ok('2.4 acota por fecha e incluye el día entero', porFecha.json.total > 0, `${porFecha.json.total} movimientos hoy`);

const viejo = await p('/api/usuarios/auditoria?limite=100&hasta_fecha=2020-01-01', { cookie: cookieAna });
ok('2.5 un rango sin nada devuelve vacío, no error', viejo.status === 200 && viejo.json.total === 0, `status ${viejo.status}`);

const fechaMala = await p('/api/usuarios/auditoria?desde_fecha=ayer', { cookie: cookieAna });
ok('2.6 una fecha mal escrita lo dice en castellano', fechaMala.status === 400 && /AAAA-MM-DD/.test(JSON.stringify(fechaMala.json)), JSON.stringify(fechaMala.json).slice(0, 110));

// ── 3. Retención ────────────────────────────────────────────────────────────
const estado = await p('/api/retencion');
ok('3.1 el estado dice qué hay guardado', estado.status === 200 && typeof estado.json.total === 'number' && estado.json.dias === 90,
   `${estado.json.total} conversaciones, plazo ${estado.json.dias} días`);

const puesto = await p('/api/retencion', { m: 'PUT', b: { dias: 30 } });
ok('3.2 se puede cambiar el plazo', puesto.status === 200 && puesto.json.dias === 30, `status ${puesto.status}`);

const negativo = await p('/api/retencion', { m: 'PUT', b: { dias: -5 } });
ok('3.3 rechaza un plazo imposible', negativo.status === 400, `status ${negativo.status}`);

const cero = await p('/api/retencion', { m: 'PUT', b: { dias: 0 } });
ok('3.4 cero se acepta: es "no borrar nunca"', cero.status === 200 && cero.json.a_borrar === 0, `a_borrar ${cero.json.a_borrar}`);

await p('/api/retencion', { m: 'PUT', b: { dias: 90 } });

// La cocina no tiene por qué ver ni tocar esto.
const cocinaCookie = (await p('/api/auth/login', { m: 'POST', b: { usuario: 'caro', clave: 'clave-de-prueba' } })).cookie;
const cocinaMira = await p('/api/retencion', { cookie: cocinaCookie });
ok('3.5 la cocina no accede a la retención', cocinaMira.status === 403, `status ${cocinaMira.status}`);

// ── 4. Dueño único ──────────────────────────────────────────────────────────
const usuarios = await p('/api/usuarios', { cookie: cookieAna });
ok('4.1 el panel sabe cuántos dueños activos hay', typeof usuarios.json.duenios_activos === 'number', `${usuarios.json.duenios_activos} dueños`);

const segundo = await p('/api/usuarios', { m: 'POST', cookie: cookieAna, b: { name: 'Dani', usuario: 'dani', clave: 'clave-de-prueba', role: 'dueño' } });
const despues = await p('/api/usuarios', { cookie: cookieAna });
ok('4.2 al dar de alta un segundo dueño, el aviso se apaga', segundo.status === 200 && despues.json.duenios_activos === 2, `${despues.json.duenios_activos}`);

console.log(`\n=== ${res.filter(Boolean).length}/${res.length} casos OK ===`);
const fallas = res.filter((x) => !x).length;
process.exit(fallas ? 1 : 0);
