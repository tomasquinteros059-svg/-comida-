const BASE = 'http://127.0.0.1:3000';
const T = 'token-de-qa-bien-largo-32b';
const p = async (ruta, { metodo = 'GET', cuerpo, publico } = {}) => {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: { ...(cuerpo ? { 'content-type': 'application/json' } : {}), ...(publico ? {} : { authorization: `Bearer ${T}` }) },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const t = await res.text();
  try { return { status: res.status, json: JSON.parse(t) }; } catch { return { status: res.status, json: t }; }
};
const ok = (c, v, d = '') => console.log(`${v ? 'OK  ' : 'FALLA'} ${c}${d ? ` — ${d}` : ''}`);

// ── Ciclo de vida de un pedido ──────────────────────────────────────────────
const antes = (await p('/api/stock/ingredients')).json;
const stockDe = (lista, nombre) => lista.find((i) => i.name === nombre)?.stock_qty;
const tapasAntes = stockDe(antes, 'Tapas de empanada');

const c1 = await p('/api/chat', { metodo: 'POST', publico: true, cuerpo: { message: 'quiero 3 empanadas de carne' } });
const conv = c1.json.conversation_id;
const c2 = await p('/api/chat', { metodo: 'POST', publico: true, cuerpo: { conversation_id: conv, message: 'confirmo' } });
console.log('   bot:', String(c2.json.reply).replace(/\n/g, ' ').slice(0, 160));

const cocina = (await p('/api/orders/kitchen')).json;
const pedido = cocina[cocina.length - 1];
ok('A.1 el pedido cae en la cocina', !!pedido, pedido ? `${pedido.code} · ${pedido.status} · ${pedido.items?.map(i => i.qty + 'x' + i.product_name).join(', ')}` : '');

const despues = (await p('/api/stock/ingredients')).json;
ok('A.2 descuenta el insumo por receta', stockDe(despues, 'Tapas de empanada') < tapasAntes,
   `tapas ${tapasAntes} -> ${stockDe(despues, 'Tapas de empanada')}`);

for (const estado of ['en_preparacion', 'listo', 'entregado']) {
  const r = await p(`/api/orders/${pedido.id}/status`, { metodo: 'POST', cuerpo: { status: estado } });
  ok(`A.3 pasa a ${estado}`, r.status === 200, `status ${r.status} ${r.status !== 200 ? JSON.stringify(r.json) : ''}`);
}
const salto = await p(`/api/orders/${pedido.id}/status`, { metodo: 'POST', cuerpo: { status: 'pendiente' } });
ok('A.4 no deja volver atrás desde entregado', salto.status >= 400, `status ${salto.status}`);

// ── Cancelar devuelve el stock ──────────────────────────────────────────────
const c3 = await p('/api/chat', { metodo: 'POST', publico: true, cuerpo: { message: 'dame 2 empanadas de carne' } });
await p('/api/chat', { metodo: 'POST', publico: true, cuerpo: { conversation_id: c3.json.conversation_id, message: 'confirmo' } });
const cocina2 = (await p('/api/orders/kitchen')).json;
const pedido2 = cocina2[cocina2.length - 1];
const antesCancelar = stockDe((await p('/api/stock/ingredients')).json, 'Tapas de empanada');
const can = await p(`/api/orders/${pedido2.id}/status`, { metodo: 'POST', cuerpo: { status: 'cancelado' } });
const despuesCancelar = stockDe((await p('/api/stock/ingredients')).json, 'Tapas de empanada');
ok('B.1 cancelar devuelve el stock', can.status === 200 && despuesCancelar > antesCancelar,
   `${antesCancelar} -> ${despuesCancelar}`);

// ── Lo que no hay no se ofrece ──────────────────────────────────────────────
const ing = (await p('/api/stock/ingredients')).json;
const tomate = ing.find((i) => i.name === 'Tomate');
await p(`/api/stock/ingredients/${tomate.id}/movements`, { metodo: 'POST', cuerpo: { delta: -tomate.stock_qty, reason: 'merma' } });
await p('/api/stock/sync-availability', { metodo: 'POST' });
const pide = await p('/api/chat', { metodo: 'POST', publico: true, cuerpo: { message: 'quiero una pizza napolitana' } });
console.log('   bot (sin tomate):', String(pide.json.reply).replace(/\n/g, ' ').slice(0, 220));
ok('C.1 el bot no toma lo que no se puede hacer', !/agregu[eé]/i.test(String(pide.json.reply)));

// D.0 reponer dos veces no pide dos veces
const rep1 = await p('/api/procurement/replenish', { metodo: 'POST', cuerpo: { urgency: 'express' } });
const rep2 = await p('/api/procurement/replenish', { metodo: 'POST', cuerpo: { urgency: 'express' } });
ok('C.2 reponer dos veces no duplica el pedido', rep1.json.purchase_orders.length > 0 && rep2.json.purchase_orders.length === 0,
   `1ra: ${rep1.json.purchase_orders.length} órdenes · 2da: ${rep2.json.purchase_orders.length} órdenes, ${rep2.json.already_ordered.length} ya en camino`);

// ── Reservas: dos chats no se llevan la misma última unidad ─────────────────
await p(`/api/stock/ingredients/${tomate.id}/movements`, { metodo: 'POST', cuerpo: { delta: 0.5, reason: 'compra' } });
await p('/api/stock/sync-availability', { metodo: 'POST' });
const a = await p('/api/chat', { metodo: 'POST', publico: true, cuerpo: { message: 'quiero 2 pizzas napolitanas' } });
const b = await p('/api/chat', { metodo: 'POST', publico: true, cuerpo: { message: 'quiero 2 pizzas napolitanas' } });
console.log('   chat A:', String(a.json.reply).replace(/\n/g, ' ').slice(0, 130));
console.log('   chat B:', String(b.json.reply).replace(/\n/g, ' ').slice(0, 130));

// ── Reportes ────────────────────────────────────────────────────────────────
for (const ruta of ['/api/dashboard', '/api/sales', '/api/menu-performance', '/api/lagging', '/api/demand-gaps', '/api/settings']) {
  const r = await p(ruta);
  ok(`D ${ruta}`, r.status === 200, `status ${r.status}`);
}
const dash = (await p('/api/dashboard')).json;
console.log('   panel hoy:', JSON.stringify(dash.today), '| en curso:', dash.open_orders, '| cocina:', dash.kitchen);

// ── Ingesta ─────────────────────────────────────────────────────────────────
const csv = 'nombre,categoria,precio\nFlan casero,Postres,$2.800\nBudin de pan,Postres,$2.500\n';
const prev = await p('/api/ingest/preview', { metodo: 'POST', cuerpo: { filename: 'postres.csv', content: csv } });
ok('E.1 la ingesta previsualiza sin escribir', prev.status === 200, JSON.stringify(prev.json).slice(0, 220));
const apl = await p('/api/ingest/apply', { metodo: 'POST', cuerpo: { filename: 'postres.csv', content: csv, kind: prev.json.kind } });
ok('E.2 y después aplica', apl.status === 200, JSON.stringify(apl.json).slice(0, 200));
const prods = (await p('/api/menu/products?all=1')).json;
const flan = (prods.products ?? prods).find?.((x) => x.name === 'Flan casero');
ok('E.3 el producto quedó con el precio bien', flan?.price_cents === 280000, `price_cents ${flan?.price_cents}`);
