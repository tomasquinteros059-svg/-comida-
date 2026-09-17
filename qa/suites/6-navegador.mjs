import { chromium, devices } from 'playwright';
const B = 'http://127.0.0.1:3000';
const QA = process.env.QA;
const errores = [];
const res = [];
const ok = (c, v, d = '') => { res.push(v); console.log(`${v ? 'OK  ' : 'FALLA'} ${c}${d ? ` — ${d}` : ''}`); };

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function sesion(nombre, viewport, pasos) {
  const ctx = await br.newContext(viewport);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errores.push(`[${nombre}] excepcion: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errores.push(`[${nombre}] consola: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) errores.push(`[${nombre}] ${r.status()} ${r.url().replace(B, '')}`); });
  await pasos(page);
  await ctx.close();
}

const entrar = async (page, usuario, clave) => {
  await page.goto(B, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.acceso-caja, .sidebar');
  if (await page.$('.acceso-caja')) {
    await page.fill('input[autocomplete="username"]', usuario);
    await page.fill('input[autocomplete="current-password"]', clave);
    await page.click('button[type="submit"]');
    await page.waitForSelector('.sidebar', { timeout: 15000 });
  }
  await page.waitForTimeout(1500);
};

// Treinta movimientos: con menos no hay segunda página y el paginador no
// tiene nada que mostrar.
const T = 'token-de-qa-bien-largo-32b';
for (let i = 0; i < 30; i++) {
  await fetch(B + '/api/menu/categories', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` },
    body: JSON.stringify({ name: `Prueba ${i}` }),
  });
}

await sesion('escritorio', { viewport: { width: 1280, height: 1000 } }, async (page) => {
  await entrar(page, 'ana', 'clave-de-prueba');

  // ── Usuarios: aviso de dueño único, bitácora con filtros y paginador ──
  await page.goto(B + '/#/usuarios', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${QA}/20-usuarios.png`, fullPage: true });

  const cuerpo = await page.textContent('body');
  ok('A.1 el aviso de dueño único NO aparece (ya hay dos)', !/Hay un solo dueño/.test(cuerpo));

  const hayPaginador = await page.$('.paginador') !== null;
  ok('A.2 la bitácora muestra el paginador', hayPaginador);

  const tramo = await page.textContent('.paginador .muted').catch(() => '');
  ok('A.3 el paginador dice el tramo y el total', /\d+–\d+ de \d+/.test(tramo ?? ''), JSON.stringify(tramo));

  // Pasar de página y volver
  const primeraFila = await page.textContent('.card tbody tr');
  await page.click('.paginador button:has-text("Siguiente")');
  await page.waitForTimeout(1500);
  const segundaFila = await page.textContent('.card tbody tr');
  const tramo2 = await page.textContent('.paginador .muted').catch(() => '');
  ok('A.3b pasar de página trae otras filas', primeraFila !== segundaFila, JSON.stringify(tramo2));

  await page.click('.paginador button:has-text("Anterior")');
  await page.waitForTimeout(1500);
  ok('A.3c volver trae las de antes', (await page.textContent('.card tbody tr')) === primeraFila);

  // Filtrar por persona. Se elige de la lista real, no un nombre inventado:
  // quien figura depende de quien haya tocado algo en esta corrida.
  // Se compara el TOTAL del paginador y no las filas visibles: las filas se
  // topan en el tamaño de página y dos totales distintos se verían iguales.
  const totalDe = async () => {
    const t = (await page.textContent('.paginador .muted').catch(() => '')) ?? '';
    const m = t.match(/de (\d+)/);
    return m ? Number(m[1]) : (await page.$$eval('.card tbody tr', (f) => f.length));
  };
  const totalAntes = await totalDe();
  const personas = await page.$$eval('#bitacora-quien option', (o) =>
    o.map((x) => x.value).filter(Boolean),
  );
  const quienElegido = personas.find((q) => q === 'Ana') ?? personas[0];
  await page.selectOption('#bitacora-quien', quienElegido);
  await page.waitForTimeout(1500);
  const totalFiltrado = await totalDe();
  const soloEsa = await page.$$eval(
    '.card tbody tr',
    (f, quien) => f.every((x) => (x.textContent ?? '').includes(quien)),
    quienElegido,
  );
  ok('A.4 filtrar por persona deja solo sus movimientos',
     personas.length >= 2 && totalFiltrado > 0 && totalFiltrado < totalAntes && soloEsa,
     `${quienElegido}: ${totalAntes} → ${totalFiltrado} (personas: ${personas.join(', ')})`);
  await page.screenshot({ path: `${QA}/21-bitacora-filtrada.png`, fullPage: true });

  // Filtro que no da resultados
  await page.fill('#bitacora-texto', 'zzzz-no-existe');
  await page.waitForTimeout(1500);
  const vacio = await page.textContent('body');
  ok('A.5 sin resultados lo explica en vez de quedar en blanco', /No hay movimientos con esos filtros/.test(vacio));

  // Limpiar
  await page.click('text=Limpiar');
  await page.waitForTimeout(1500);
  const totalLimpio = await totalDe();
  ok('A.6 "Limpiar" devuelve todo', totalLimpio === totalAntes, `${totalLimpio} vs ${totalAntes}`);

  // ── Compras y cocina: siguen mostrando datos con la respuesta paginada ──
  await page.goto(B + '/#/compras', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const compras = await page.textContent('body');
  ok('B.1 Compras renderiza con la respuesta paginada', !/No pude cargar/.test(compras) && /Ordenes/.test(compras));

  await page.goto(B + '/#/cocina', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const cocina = await page.textContent('body');
  ok('B.2 Cocina renderiza los cerrados recientemente', /Cerrados recientemente|En espera/.test(cocina));

  await page.goto(B + '/#/chat', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  ok('B.3 Chatbot renderiza', !/No pude cargar/.test(await page.textContent('body')));

  // ── Retención ──
  await page.goto(B + '/#/bot', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const bot = await page.textContent('body');
  ok('C.1 la tarjeta de retención está', /Cuánto se guardan las conversaciones/.test(bot));
  ok('C.2 explica por qué importa', /nombres, teléfonos/.test(bot));
  await page.screenshot({ path: `${QA}/22-retencion.png`, fullPage: true });

  const dias = await page.inputValue('#retencion-dias');
  ok('C.3 muestra el plazo vigente', /^\d+$/.test(dias), `dice ${dias}`);

  const nuevo = String(Number(dias) === 45 ? 60 : 45);
  await page.fill('#retencion-dias', nuevo);
  await page.waitForTimeout(400);
  // Por nombre accesible: la pantalla tiene mas de un "Guardar" y el primero
  // que aparece no es siempre el de retencion.
  await page.getByRole('button', { name: 'Guardar el plazo de retención' }).click();
  await page.waitForTimeout(2500);
  const guardado = await page.inputValue('#retencion-dias');
  ok('C.4 se puede cambiar desde el panel', guardado === nuevo, `${dias} → ${guardado}`);

  // Y que haya quedado guardado de verdad, no solo en la pantalla.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const tras = await page.inputValue('#retencion-dias');
  ok('C.5 el plazo sobrevive a recargar', tras === nuevo, `quedó en ${tras}`);
});

// ── El aviso de dueño único, con un solo dueño ──
await sesion('aviso', { viewport: { width: 1280, height: 900 } }, async (page) => {
  await entrar(page, 'ana', 'clave-de-prueba');
  await page.goto(B + '/#/usuarios', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // Dar de baja al segundo dueño para que quede uno solo.
  const filas = await page.$$('.usuario-fila');
  for (const fila of filas) {
    const t = await fila.textContent();
    if (t && /dani/.test(t)) {
      const boton = await fila.$('button:has-text("Dar de baja")');
      if (boton) await boton.click();
      break;
    }
  }
  await page.waitForTimeout(2500);
  const cuerpo = await page.textContent('body');
  ok('A.7 con un solo dueño, el panel avisa', /Hay un solo dueño/.test(cuerpo));
  await page.screenshot({ path: `${QA}/23-aviso-dueno.png`, fullPage: true });
});

// ── Teléfono ──
await sesion('telefono', devices['iPhone 13'], async (page) => {
  await entrar(page, 'ana', 'clave-de-prueba');
  await page.goto(B + '/#/usuarios', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${QA}/24-tel-usuarios.png`, fullPage: true });
  const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  ok('D.1 la pantalla de usuarios no desborda en el teléfono', m.s <= m.w + 1, JSON.stringify(m));

  await page.goto(B + '/#/bot', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const m2 = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  ok('D.2 la de retención tampoco', m2.s <= m2.w + 1, JSON.stringify(m2));
  await page.screenshot({ path: `${QA}/25-tel-retencion.png`, fullPage: true });
});

await br.close();
console.log(`\n=== ${res.filter(Boolean).length}/${res.length} casos OK ===`);
const unicos = [...new Set(errores)];
console.log('problemas de consola/red:', unicos.length ? unicos : 'ninguno');
