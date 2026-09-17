import { chromium, devices } from 'playwright';
const BASE = 'http://127.0.0.1:3000';
const QA = process.env.QA;
const errores = [];


const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function sesion(nombre, viewport, pasos) {
  const ctx = await browser.newContext(viewport);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errores.push(`[${nombre}] consola: ${m.text()}`); });
  page.on('pageerror', (e) => errores.push(`[${nombre}] excepcion: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) errores.push(`[${nombre}] ${r.status()} ${r.url().replace(BASE,'')}`); });
  await pasos(page);
  await ctx.close();
}

const tiro = (page, nombre) => page.screenshot({ path: `${QA}/${nombre}.png`, fullPage: true });

// ── Escritorio: dueño ───────────────────────────────────────────────────────
await sesion('escritorio-dueño', {}, async (page) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.acceso-caja, .app');
  await tiro(page, '01-ingreso');

  await page.fill('input[autocomplete="username"]', 'ana');
  await page.fill('input[autocomplete="current-password"]', 'clave-de-prueba');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.sidebar', { timeout: 10000 });
  await page.waitForTimeout(1200);
  await tiro(page, '02-panel-dueño');
  console.log('menu dueño:', await page.$$eval('.nav-item', (n) => n.map((x) => x.textContent.trim())));

  await page.goto(BASE + '/#/usuarios', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await tiro(page, '03-usuarios');

  await page.goto(BASE + '/#/stock', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await tiro(page, '04-stock');

  await page.goto(BASE + '/#/cocina', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await tiro(page, '05-cocina');
});

// ── Escritorio: cocina (rol limitado) ───────────────────────────────────────
await sesion('escritorio-cocina', {}, async (page) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.acceso-caja');
  await page.fill('input[autocomplete="username"]', 'caro');
  await page.fill('input[autocomplete="current-password"]', 'clave-de-prueba');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  const menu = await page.$$eval('.nav-item', (n) => n.map((x) => x.textContent.trim())).catch(() => []);
  console.log('menu cocina:', menu);
  await tiro(page, '06-cocina-rol');
});

// ── Telefono ────────────────────────────────────────────────────────────────
await sesion('telefono', devices['iPhone 13'], async (page) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.acceso-caja');
  await tiro(page, '07-tel-ingreso');
  await page.fill('input[autocomplete="username"]', 'ana');
  await page.fill('input[autocomplete="current-password"]', 'clave-de-prueba');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await tiro(page, '08-tel-panel');
  await page.goto(BASE + '/#/usuarios', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  await tiro(page, '09-tel-usuarios');
  const ancho = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, ventana: window.innerWidth }));
  console.log('ancho telefono:', JSON.stringify(ancho), ancho.scroll > ancho.ventana + 1 ? '← SE DESBORDA' : 'ok');
});

await browser.close();
console.log('\n--- problemas detectados ---');
if (!errores.length) console.log('ninguno');
for (const e of [...new Set(errores)]) console.log(' ·', e);
