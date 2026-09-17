import net from 'node:net';
import http from 'node:http';

/**
 * Un GET con la cabecera Host puesta a mano: fetch no la deja tocar, y el
 * ruteo por dominio es justamente lo que hay que probar.
 */
const conHost = (ruta, host) =>
  new Promise((resolver, rechazar) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: 3000, path: ruta, method: 'GET',
        headers: { host, authorization: `Bearer ${T}` } },
      (res) => {
        let cuerpo = '';
        res.on('data', (c) => (cuerpo += c));
        res.on('end', () => resolver({ status: res.statusCode, local: res.headers['x-local'], cuerpo }));
      },
    );
    req.on('error', rechazar);
    req.end();
  });
const B = 'http://127.0.0.1:3000';
const T = 'token-de-qa-bien-largo-32b';
const res = [];
const ok = (c, v, d = '') => { res.push(v); console.log(`${v ? 'OK  ' : 'FALLA'} ${c}${d ? ` — ${d}` : ''}`); };

const p = async (r, { m = 'GET', b, cookie, host, local } = {}) => {
  const s = await fetch(B + r, {
    method: m,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : { authorization: `Bearer ${T}` }),
      ...(host ? { host } : {}),
      ...(local ? { 'x-local': local } : {}),
    },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  const t = await s.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: s.status, json: j, headers: s.headers, texto: t };
};

// ══ 1. COMANDERA ════════════════════════════════════════════════════════════
const cfg = await p('/api/orders/comandera/config');
ok('1.1 la configuración de la comandera existe', cfg.status === 200 && cfg.json.puerto === 9100, `puerto ${cfg.json.puerto}`);

// Una comandera de mentira, escuchando de verdad
const recibido = [];
const impresora = net.createServer((s) => s.on('data', (d) => recibido.push(d)));
const puerto = await new Promise((r) => impresora.listen(0, '0.0.0.0', () => r(impresora.address().port)));

// El contenedor sale a la red del host por host.docker.internal
// La IP del host desde adentro del contenedor. Con compose la red es propia,
// asi que se pregunta cual es en vez de suponer.
const hostImpresora = process.env.HOST_DESDE_CONTENEDOR ?? '172.17.0.1';
const puesta = await p('/api/orders/comandera/config', { m: 'PUT', b: { host: hostImpresora, puerto, automatica: false, copias: 1 } });
ok('1.2 se puede configurar la comandera', puesta.status === 200 && puesta.json.host === hostImpresora, JSON.stringify(puesta.json));

// Un pedido para imprimir
const prods = (await p('/api/menu/products')).json;
const lista = Array.isArray(prods) ? prods : prods.products ?? [];
const producto = lista[0];
const pedido = await p('/api/orders', { m: 'POST', b: { lines: [{ product_id: producto.id, qty: 2 }], confirm: true } });
ok('1.3 se crea un pedido para imprimir', pedido.status === 200, `status ${pedido.status}`);

const bytes = await p(`/api/orders/${pedido.json.id}/comanda-bytes`);
ok('1.4 los bytes de la comanda se pueden inspeccionar', bytes.status === 200 && bytes.texto.includes('<ESC>'), bytes.texto.slice(0, 60).replace(/\n/g, ' '));
ok('1.5 la comanda no lleva acentos', !/[áéíóúñ]/.test(bytes.texto));

const impresion = await p(`/api/orders/${pedido.json.id}/imprimir`, { m: 'POST', b: {} });
await new Promise((r) => setTimeout(r, 400));
const llegaron = Buffer.concat(recibido);
ok('1.6 la comanda llega a la impresora', impresion.json.impreso === true && llegaron.length > 0,
   impresion.json.impreso ? `${llegaron.length} bytes` : impresion.json.motivo);
ok('1.7 lleva el producto', llegaron.toString('latin1').replace(/[^\x20-\x7e]/g,' ').includes(producto.name.normalize('NFD').replace(/[̀-ͯ]/g, '')),
   JSON.stringify(llegaron.toString('latin1').replace(/[^\x20-\x7e]/g,' ').slice(0,60)));

await p('/api/orders/comandera/config', { m: 'PUT', b: { host: '127.0.0.1', puerto: 9 } });
const apagada = await p(`/api/orders/${pedido.json.id}/imprimir`, { m: 'POST', b: {} });
ok('1.8 con la impresora apagada lo dice, no se cuelga', apagada.json.impreso === false && !!apagada.json.motivo, apagada.json.motivo);
impresora.close();

// ══ 2. EXCEL Y PDF ══════════════════════════════════════════════════════════
const excelB64 = process.env.EXCEL_B64;
if (excelB64) {
  const prev = await p('/api/ingest/preview', { m: 'POST', b: { content: excelB64, filename: 'carta.xlsx', base64: true } });
  ok('2.1 un Excel se previsualiza', prev.status === 200 && prev.json.creates?.length === 2, JSON.stringify(prev.json).slice(0, 140));
  ok('2.2 dice de dónde salió', /Excel/.test(prev.json.origen ?? ''), prev.json.origen);

  const apl = await p('/api/ingest/apply', { m: 'POST', b: { content: excelB64, filename: 'carta.xlsx', base64: true } });
  ok('2.3 y se aplica', apl.status === 200 && apl.json.created === 2, `${apl.json.created} creados`);

  const ahora = (await p('/api/menu/products?all=1')).json;
  const l2 = Array.isArray(ahora) ? ahora : ahora.products ?? [];
  const nuevo = l2.find((x) => x.name === 'Sanguche de milanesa');
  ok('2.4 el precio entra bien', nuevo?.price_cents === 1_250_000, `price_cents ${nuevo?.price_cents}`);

  const malo = await p('/api/ingest/preview', { m: 'POST', b: { content: 'no soy un excel', filename: 'x.xlsx', base64: true } });
  ok('2.5 un archivo roto lo dice, no rompe el servidor', malo.status >= 400 && malo.status < 500, `status ${malo.status}`);
}

// ══ 3. WHATSAPP ═════════════════════════════════════════════════════════════
const alta = await fetch(`${B}/api/whatsapp?hub.mode=subscribe&hub.verify_token=cualquiera&hub.challenge=999`);
ok('3.1 el webhook rechaza una palabra de verificación que no es', alta.status === 403, `status ${alta.status}`);

const sinFirma = await fetch(`${B}/api/whatsapp`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: [] }),
});
ok('3.2 sin firma no entra', sinFirma.status === 401 || sinFirma.status === 503, `status ${sinFirma.status}`);

const estadoWa = await p('/api/canales/whatsapp');
ok('3.3 el panel ve el estado y qué falta', estadoWa.status === 200 && Array.isArray(estadoWa.json.falta), JSON.stringify(estadoWa.json).slice(0, 120));
// Lo que no puede aparecer NUNCA es el VALOR de una credencial.
const secretosReales = ['token-de-prueba', 'clave-de-la-app', process.env.WHATSAPP_TOKEN, process.env.WHATSAPP_APP_SECRET].filter(Boolean);
const cuerpoWa = JSON.stringify(estadoWa.json);
// El estado trae de DONDE sale cada credencial, asi que hay claves llamadas
// "token" y "appSecret". Solo pueden valer falta/panel/entorno: si alguna vez
// alguien mete ahi el valor de verdad, esto lo agarra.
const soloElOrigen = !/"(token|appSecret|verifyToken|phoneNumberId)"\s*:\s*"(?!falta"|panel"|entorno")/.test(cuerpoWa);
ok('3.4 NUNCA devuelve el valor del token ni de la clave',
   secretosReales.every((x) => !cuerpoWa.includes(x)) && soloElOrigen, cuerpoWa.slice(0, 120));

// ══ 4. COBROS ═══════════════════════════════════════════════════════════════
const estadoCobros = await p('/api/cobros/estado');
ok('4.1 cobrar a mano funciona sin configurar nada', estadoCobros.status === 200 && estadoCobros.json.medios.includes('efectivo'));

const pendientes = await p('/api/cobros/pendientes');
ok('4.2 lo que falta cobrar se puede ver', pendientes.status === 200 && Array.isArray(pendientes.json.pedidos), `${pendientes.json.pedidos?.length} pedidos`);

const cobrado = await p(`/api/cobros/pedido/${pedido.json.id}/pagado`, { m: 'POST', b: { medio: 'efectivo' } });
ok('4.3 se cobra en el mostrador', cobrado.status === 200, `status ${cobrado.status}`);

const caja = await p('/api/cobros/caja');
ok('4.4 el cierre de caja suma por medio', caja.status === 200 && caja.json.cobrado_cents > 0, `$${caja.json.cobrado_cents / 100}`);

const deshecho = await p(`/api/cobros/pedido/${pedido.json.id}/sin-pagar`, { m: 'POST', b: { motivo: 'prueba' } });
const pagos = await p(`/api/cobros/pedido/${pedido.json.id}`);
ok('4.5 deshacer deja los dos registros, no borra', deshecho.status === 200 && pagos.json.length === 2, `${pagos.json.length} registros`);

const medioInventado = await p(`/api/cobros/pedido/${pedido.json.id}/pagado`, { m: 'POST', b: { medio: 'bitcoin' } });
ok('4.6 un medio inventado se rechaza en castellano', medioInventado.status === 400 && !/Invalid enum/.test(JSON.stringify(medioInventado.json)), JSON.stringify(medioInventado.json).slice(0, 110));

const webhookSinFirma = await fetch(`${B}/api/cobros/webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'payment', data: { id: '1' } }),
});
ok('4.7 el aviso de pago sin firma se rechaza', webhookSinFirma.status === 401, `status ${webhookSinFirma.status}`);

// ══ 5. VARIOS LOCALES ═══════════════════════════════════════════════════════
const locales0 = await p('/api/locales');
ok('5.1 con un solo local, nada cambia', locales0.status === 200 && locales0.json.varios === false && locales0.json.locales.length === 1,
   `${locales0.json.locales.length} locales: ${locales0.json.locales.map((l) => l.slug).join(', ')}`);

const creado = await p('/api/locales', { m: 'POST', b: { nombre: 'Don José', hosts: ['donjose.test'] } });
ok('5.2 se puede sumar un local', creado.status === 200 && creado.json.slug === 'don-jose', JSON.stringify(creado.json).slice(0, 110));

const dup = await p('/api/locales', { m: 'POST', b: { nombre: 'Otro', hosts: ['donjose.test'] } });
ok('5.3 un dominio no puede llevar a dos locales, y lo explica',
   dup.status === 409 && /ya lleva al local/.test(JSON.stringify(dup.json)), JSON.stringify(dup.json).slice(0, 120));

// El local nuevo arranca vacío: la carta del principal NO se ve
const cartaNueva = await p('/api/menu/products', { local: 'don-jose' });
const lNueva = Array.isArray(cartaNueva.json) ? cartaNueva.json : cartaNueva.json.products ?? [];
ok('5.4 el local nuevo NO ve la carta del otro', cartaNueva.status === 200 && lNueva.length === 0, `${lNueva.length} productos`);

const pedidosNuevo = await p('/api/orders?limite=5', { local: 'don-jose' });
ok('5.5 ni sus pedidos ni su facturación', pedidosNuevo.json.total === 0, `total ${pedidosNuevo.json.total}`);

const usuariosNuevo = await p('/api/usuarios', { local: 'don-jose' });
ok('5.6 ni sus usuarios: la clave de uno no abre el otro', usuariosNuevo.json.usuarios?.length === 0, `${usuariosNuevo.json.usuarios?.length} usuarios`);

const principal = await p('/api/menu/products');
const lPrin = Array.isArray(principal.json) ? principal.json : principal.json.products ?? [];
ok('5.7 y el principal sigue con la suya intacta', lPrin.length > 0, `${lPrin.length} productos`);

// El dominio manda: cada uno entra al suyo.
const porDominio = await conHost('/api/menu/products', 'donjose.test');
ok('5.8 el dominio decide a que local entra', porDominio.local === 'don-jose', `fue a "${porDominio.local}"`);

// Y lo que no coincide con nadie cae en el principal, NUNCA en el local ajeno.
const desconocido = await conHost('/api/menu/products', 'nadie.test');
ok('5.8b un dominio desconocido cae en el principal, nunca en el local ajeno',
   desconocido.local === 'principal', `fue a "${desconocido.local}"`);

const conCabecera = await p('/api/menu/products', { local: 'don-jose' });
ok('5.9 la respuesta dice a qué local fue', conCabecera.headers.get('x-local') === 'don-jose', conCabecera.headers.get('x-local'));

const cartaPrincipal = await conHost('/api/menu/products', 'nadie.test');
ok('5.9b y el principal sigue con su carta intacta', /Empanada|Pizza/.test(cartaPrincipal.cuerpo), cartaPrincipal.cuerpo.slice(0, 60));

await p(`/api/locales/don-jose`, { m: 'PATCH', b: { activo: false } });
const desactivado = await p('/api/menu/products', { local: 'don-jose' });
ok('5.10 un local desactivado no atiende', desactivado.status === 503, `status ${desactivado.status}`);
await p(`/api/locales/don-jose`, { m: 'PATCH', b: { activo: true } });

const apagarPrincipal = await p('/api/locales/principal', { m: 'PATCH', b: { activo: false } });
ok('5.11 el principal no se puede desactivar: quedarías sin panel',
   apagarPrincipal.status === 409, `status ${apagarPrincipal.status}`);

console.log(`\n=== ${res.filter(Boolean).length}/${res.length} casos OK ===`);
process.exit(res.filter((x) => !x).length ? 1 : 0);
