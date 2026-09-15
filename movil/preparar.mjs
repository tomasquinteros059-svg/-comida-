/**
 * Deja todo listo para que Gradle arme el APK.
 *
 * El APK lleva la demo adentro: abre sin servidor, sin internet y sin cargar
 * nada. Es para ver cómo funciona el panel, no para atender el local —para
 * eso está el servidor de verdad, que se entra desde el navegador del
 * teléfono y no necesita instalar ninguna aplicación.
 *
 * Lo que hace, en orden:
 *   1. Se fija que la demo esté compilada (npm run build:demo).
 *   2. La copia a www/, que es de donde lee Capacitor.
 *   3. Crea el proyecto de Android si no está, y lo sincroniza.
 *
 * El proyecto de Android no se guarda en el repositorio: son cientos de
 * archivos que genera Capacitor solo, y que hay que regenerar igual cada vez
 * que cambia la version. Se arma acá en un segundo.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aca = dirname(fileURLToPath(import.meta.url));
const demo = join(aca, '..', 'web', 'dist-demo');
const www = join(aca, 'www');

if (!existsSync(join(demo, 'index.html'))) {
  console.error('Falta la demo compilada. Corré esto primero, desde la raíz:');
  console.error('');
  console.error('  npm install && npm run build:demo');
  process.exit(1);
}

rmSync(www, { recursive: true, force: true });
cpSync(demo, www, { recursive: true });
// Los .map son para depurar en la compu: adentro del APK son 600 kB al pedo.
for (const archivo of readdirSync(join(www, 'assets'))) {
  if (archivo.endsWith('.map')) rmSync(join(www, 'assets', archivo));
}
console.log('la demo quedó en movil/www');

const cap = (...args) => execFileSync('npx', ['cap', ...args], { cwd: aca, stdio: 'inherit' });

if (!existsSync(join(aca, 'android'))) cap('add', 'android');
else cap('sync', 'android');

// El icono. Capacitor deja el suyo, que en el cajon de aplicaciones no se
// distingue de cualquier otra app hecha con Capacitor.
const res = join(aca, 'android', 'app', 'src', 'main', 'res');
for (const carpeta of readdirSync(join(aca, 'iconos'))) {
  cpSync(join(aca, 'iconos', carpeta), join(res, carpeta), { recursive: true });
}
// El icono adaptativo pone las letras sobre este color: en blanco, que es lo
// que viene, las letras claras no se ven.
const fondo = join(res, 'values', 'ic_launcher_background.xml');
writeFileSync(fondo, readFileSync(fondo, 'utf8').replace('#FFFFFF', '#C2410C'));
console.log('el icono quedó puesto');

console.log('');
console.log('Listo. Para armar el APK hace falta el SDK de Android:');
console.log('  cd movil/android && ./gradlew assembleDebug');
console.log('Queda en movil/android/app/build/outputs/apk/debug/app-debug.apk');
