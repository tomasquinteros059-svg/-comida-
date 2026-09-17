import { chromium, devices } from 'playwright';
const B = 'http://127.0.0.1:3000';
const QA = process.env.QA;
const errores = [];
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const ctx = await br.newContext(devices['iPhone 13']);
const page = await ctx.newPage();
page.on('pageerror', (e) => errores.push('excepcion: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errores.push('consola: ' + m.text()); });

await page.goto(B, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.acceso-caja');
await page.fill('input[autocomplete="username"]', 'beto');
await page.fill('input[autocomplete="current-password"]', 'clave-de-prueba');
await page.click('button[type="submit"]');
await page.waitForTimeout(2500);

// El botón con el propio nombre abre el cambio de clave.
await page.click('button[title="Cambiar mi clave"]');
await page.waitForSelector('.modal', { timeout: 5000 });
await page.screenshot({ path: `${QA}/10-tel-cambiar-clave.png`, fullPage: true });

// Primero mal a propósito: clave actual equivocada.
await page.fill('#clave-actual', 'no-es-esta');
await page.fill('#clave-nueva', 'la-clave-nueva-1');
await page.fill('#clave-repetida', 'la-clave-nueva-1');
await page.click('.modal button.primary');
await page.waitForTimeout(1200);
const errorVisible = await page.textContent('.acceso-error').catch(() => null);
console.log('con la clave actual mal, muestra:', JSON.stringify(errorVisible));
await page.screenshot({ path: `${QA}/11-tel-clave-error.png`, fullPage: true });

// Ahora bien.
await page.fill('#clave-actual', 'clave-de-prueba');
await page.click('.modal button.primary');
await page.waitForTimeout(1800);
const confirmacion = await page.textContent('.modal').catch(() => '');
console.log('tras cambiarla:', JSON.stringify(confirmacion.replace(/\s+/g, ' ').slice(0, 120)));
await page.screenshot({ path: `${QA}/12-tel-clave-lista.png`, fullPage: true });

// Sigue adentro: cierra el modal y navega.
await page.click('.modal button.primary');
await page.waitForTimeout(600);
await page.goto(B + '/#/stock', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
const entro = await page.$('.card') !== null;
console.log('sigue adentro después de cambiarla:', entro ? 'sí' : 'NO');

const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
console.log('ancho:', JSON.stringify(m), m.s > m.w + 1 ? 'DESBORDA' : 'ok');

await ctx.close();
await br.close();
console.log('\nproblemas:', errores.length ? [...new Set(errores)] : 'ninguno');
