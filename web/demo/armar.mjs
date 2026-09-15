/**
 * Termina de armar la demo despues de `vite build`.
 *
 * Vite deja el HTML pelado. Lo que falta es lo que hace que en el telefono
 * "Agregar a la pantalla de inicio" quede como una aplicacion y no como un
 * acceso directo del navegador: el manifest, el icono y las etiquetas de iOS,
 * que no leen el manifest.
 *
 * Se corre solo: `npm run build:demo` lo llama al final.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aca = dirname(fileURLToPath(import.meta.url));
const destino = join(aca, '..', 'dist-demo');

for (const archivo of ['app.webmanifest', 'icono.png']) {
  copyFileSync(join(aca, archivo), join(destino, archivo));
}

const html = join(destino, 'index.html');
const etiquetas = [
  '<link rel="manifest" href="./app.webmanifest" />',
  '<link rel="apple-touch-icon" href="./icono.png" />',
  '<meta name="apple-mobile-web-app-capable" content="yes" />',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
  '<meta name="apple-mobile-web-app-title" content="comeIA" />',
  '<meta name="theme-color" content="#c2410c" />',
].map((t) => `    ${t}`).join('\n');

let contenido = readFileSync(html, 'utf8');
contenido = contenido
  .replace('<title>comeIA — panel del local</title>', '<title>comeIA · demo del local</title>')
  .replace('</head>', `${etiquetas}\n  </head>`);
writeFileSync(html, contenido);

console.log('demo lista en web/dist-demo');
