const BASE = 'http://127.0.0.1:3000';
const TOKEN = 'token-de-qa-bien-largo-32b';
const resultados = [];
let cookieDuenio = '', cookieCocina = '', cookieEncargado = '';

const pedir = async (ruta, { metodo = 'GET', cuerpo, cookie, token } = {}) => {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: {
      ...(cuerpo ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const texto = await res.text();
  let json; try { json = JSON.parse(texto); } catch { json = texto; }
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] };
};

const check = (caso, ok, detalle = '') => {
  resultados.push({ caso, ok, detalle });
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${caso}${detalle ? ` — ${detalle}` : ''}`);
};

// ── 1. Arranque: no hay usuarios ────────────────────────────────────────────
let r = await pedir('/api/auth/me');
check('1.1 /auth/me avisa que no hay usuarios', r.json.sinUsuarios === true && r.json.autenticado === false, JSON.stringify(r.json));

r = await pedir('/api/auth/bootstrap', { metodo: 'POST', cuerpo: { name: 'Ana', usuario: 'ana', clave: 'clave-de-prueba' } });
check('1.2 el alta del primer dueño sin token se rechaza', r.status === 401, `status ${r.status}`);

r = await pedir('/api/auth/bootstrap', { metodo: 'POST', cuerpo: { name: 'Ana', usuario: 'ana', clave: 'clave-de-prueba', token: TOKEN } });
cookieDuenio = r.cookie;
check('1.3 con el token, crea el primer dueño y deja la sesión abierta', r.status === 200 && r.json.usuario?.role === 'dueño' && cookieDuenio.startsWith('comeia_sesion='), `status ${r.status}`);

r = await pedir('/api/auth/bootstrap', { metodo: 'POST', cuerpo: { name: 'Otro', usuario: 'otro', clave: 'clave-de-prueba', token: TOKEN } });
check('1.4 el alta del primer dueño no se puede repetir', r.status === 409, `status ${r.status}`);

// ── 2. Alta del equipo ──────────────────────────────────────────────────────
r = await pedir('/api/usuarios', { metodo: 'POST', cookie: cookieDuenio, cuerpo: { name: 'Beto', usuario: 'beto', clave: 'clave-de-prueba', role: 'encargado' } });
check('2.1 el dueño da de alta a un encargado', r.status === 200 && r.json.role === 'encargado', `status ${r.status} ${JSON.stringify(r.json)}`);

r = await pedir('/api/usuarios', { metodo: 'POST', cookie: cookieDuenio, cuerpo: { name: 'Caro', usuario: 'caro', clave: 'clave-de-prueba', role: 'cocina' } });
check('2.2 y a alguien de cocina', r.status === 200 && r.json.role === 'cocina', `status ${r.status}`);

r = await pedir('/api/usuarios', { metodo: 'POST', cookie: cookieDuenio, cuerpo: { name: 'Dup', usuario: 'beto', clave: 'clave-de-prueba', role: 'cocina' } });
check('2.3 no deja repetir el nombre de usuario', r.status === 409, `status ${r.status}`);

r = await pedir('/api/usuarios', { metodo: 'POST', cookie: cookieDuenio, cuerpo: { name: 'Floja', usuario: 'floja', clave: '1234', role: 'cocina' } });
check('2.4 rechaza una clave corta', r.status === 400, `status ${r.status}`);

// ── 3. Ingreso ──────────────────────────────────────────────────────────────
r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { usuario: 'beto', clave: 'clave-de-prueba' } });
cookieEncargado = r.cookie;
check('3.1 el encargado entra', r.status === 200 && cookieEncargado, `status ${r.status}`);

r = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { usuario: 'caro', clave: 'clave-de-prueba' } });
cookieCocina = r.cookie;
check('3.2 cocina entra', r.status === 200 && cookieCocina, `status ${r.status}`);

const mala = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { usuario: 'beto', clave: 'no-es-esta-clave' } });
const inexistente = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { usuario: 'fantasma', clave: 'no-es-esta-clave' } });
check('3.3 no distingue usuario inexistente de clave mala', mala.status === 401 && JSON.stringify(mala.json) === JSON.stringify(inexistente.json), JSON.stringify(mala.json));

// ── 4. Permisos por rol ─────────────────────────────────────────────────────
const rutas = ['/api/dashboard', '/api/menu/products', '/api/stock/ingredients', '/api/stock/alerts', '/api/procurement/suppliers', '/api/orders/kitchen', '/api/knowledge', '/api/chat/conversations', '/api/usuarios'];
const esperado = {
  dueño:     [200, 200, 200, 200, 200, 200, 200, 200, 200],
  encargado: [200, 200, 200, 200, 200, 200, 200, 200, 403],
  cocina:    [403, 403, 403, 403, 403, 200, 403, 403, 403],
};
for (const [rol, cookie] of [['dueño', cookieDuenio], ['encargado', cookieEncargado], ['cocina', cookieCocina]]) {
  const obtenido = [];
  for (const ruta of rutas) obtenido.push((await pedir(ruta, { cookie })).status);
  check(`4.${rol} ve lo que le corresponde`, JSON.stringify(obtenido) === JSON.stringify(esperado[rol]),
    obtenido.map((s, i) => `${rutas[i]}=${s}`).join(' '));
}

r = await pedir('/api/menu/categories', { metodo: 'POST', cookie: cookieCocina, cuerpo: { name: 'Prohibido' } });
check('4.4 cocina no puede escribir en la carta', r.status === 403, `status ${r.status}`);

// ── 5. Chat público y pedido completo ───────────────────────────────────────
r = await pedir('/api/chat', { metodo: 'POST', cuerpo: { message: 'hola, quiero dos empanadas de carne' } });
const conv = r.json.conversation_id;
check('5.1 el chat contesta sin credencial', r.status === 200 && !!conv && !!r.json.reply, `status ${r.status}`);
console.log('      bot:', String(r.json.reply).slice(0, 140).replace(/\n/g, ' '));

r = await pedir('/api/chat', { metodo: 'POST', cuerpo: { conversation_id: conv, message: 'nada mas, confirmo' } });
check('5.2 sigue la conversación', r.status === 200, `status ${r.status}`);
console.log('      bot:', String(r.json.reply).slice(0, 200).replace(/\n/g, ' '));
console.log('      carrito:', JSON.stringify(r.json.cart ?? r.json.order ?? null).slice(0, 200));

r = await pedir('/api/chat/conversations', {});
check('5.3 las conversaciones NO son públicas', r.status === 401, `status ${r.status}`);

// ── 6. Tablero de cocina ────────────────────────────────────────────────────
const cocinaAntes = await pedir('/api/orders/kitchen', { cookie: cookieCocina });
check('6.1 la cocina ve el tablero', cocinaAntes.status === 200 && Array.isArray(cocinaAntes.json), `status ${cocinaAntes.status}`);

// ── 7. Stock y reposición ───────────────────────────────────────────────────
const alertas = await pedir('/api/stock/alerts', { cookie: cookieEncargado });
check('7.1 hay alertas de stock calculadas', alertas.status === 200 && Array.isArray(alertas.json), `${Array.isArray(alertas.json) ? alertas.json.length : '?'} alertas`);
if (Array.isArray(alertas.json)) {
  for (const a of alertas.json.slice(0, 5)) console.log(`      · ${a.name}: ${a.level} — ${a.stock_qty} ${a.unit}, dura ${a.days_left ?? '?'} días`);
}

const rep = await pedir('/api/procurement/replenish', { metodo: 'POST', cookie: cookieEncargado, cuerpo: { hours: 24 } });
check('7.2 la reposición express arma un plan', rep.status === 200, `status ${rep.status}`);
console.log('      plan:', JSON.stringify(rep.json).slice(0, 400));

// ── 8. Auditoría ────────────────────────────────────────────────────────────
const aud = await pedir('/api/usuarios/auditoria', { cookie: cookieDuenio });
check('8.1 queda registro de quién hizo qué', aud.status === 200 && aud.json.items?.length > 0, `${aud.json.total ?? 0} entradas`);
for (const f of (aud.json.items ?? []).slice(0, 6)) console.log(`      · ${f.created_at} ${f.user_name} (${f.role}) ${f.action} ${f.target}`);

// ── 9. Cierre de sesión ─────────────────────────────────────────────────────
await pedir('/api/auth/logout', { metodo: 'POST', cookie: cookieEncargado });
r = await pedir('/api/dashboard', { cookie: cookieEncargado });
check('9.1 salir invalida la sesión', r.status === 401, `status ${r.status}`);

// cambiar la clave cierra sesiones
const usuarios = (await pedir('/api/usuarios', { cookie: cookieDuenio })).json.usuarios;
const caro = usuarios.find((u) => u.username === 'caro');
await pedir(`/api/usuarios/${caro.id}`, { metodo: 'PATCH', cookie: cookieDuenio, cuerpo: { clave: 'otra-clave-larga' } });
r = await pedir('/api/orders/kitchen', { cookie: cookieCocina });
check('9.2 cambiar la clave cierra las sesiones abiertas', r.status === 401, `status ${r.status}`);

// ── 10. Último dueño ────────────────────────────────────────────────────────
const ana = usuarios.find((u) => u.username === 'ana');
r = await pedir(`/api/usuarios/${ana.id}`, { metodo: 'PATCH', cookie: cookieDuenio, cuerpo: { role: 'cocina' } });
check('10.1 no deja degradar al único dueño', r.status === 409, `status ${r.status} ${JSON.stringify(r.json)}`);

// ── 11. Token maestro ───────────────────────────────────────────────────────
r = await pedir('/api/usuarios', { token: TOKEN });
check('11.1 el token maestro sigue entrando', r.status === 200, `status ${r.status}`);

// ── 12. Límite de intentos ──────────────────────────────────────────────────
let bloqueado = false;
for (let i = 0; i < 12; i++) {
  const x = await pedir('/api/auth/login', { metodo: 'POST', cuerpo: { usuario: 'ana', clave: `mal-${i}` } });
  if (x.status === 429) { bloqueado = true; break; }
}
check('12.1 corta la prueba de claves por fuerza bruta', bloqueado);

console.log(`\n=== ${resultados.filter((x) => x.ok).length}/${resultados.length} casos OK ===`);
const fallas = resultados.filter((x) => !x.ok);
if (fallas.length) { console.log('FALLAS:'); for (const f of fallas) console.log(` · ${f.caso} — ${f.detalle}`); }
