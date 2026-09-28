/**
 * La demo en UN solo archivo HTML.
 *
 * Para qué sirve: mandar la demo por mail, por WhatsApp, o abrirla en el panel
 * de una conversación. Se abre con doble clic, sin servidor, sin internet y
 * sin instalar nada. El de `dist-demo/` necesita que algo sirva los archivos;
 * este no.
 *
 * Son ~300 kB, casi todo el bundle de React. Vale la pena igual: la
 * alternativa es explicar cómo levantar un servidor para mirar una pantalla.
 *
 * Se corre solo: `npm run build:unico` compila y después llama a esto.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aca = dirname(fileURLToPath(import.meta.url));
const salida = join(aca, '..', 'dist-unico');

let html = readFileSync(join(salida, 'index.html'), 'utf8');

const nombreDe = (patron) => {
  const encontrado = html.match(patron);
  if (!encontrado) {
    throw new Error(
      `No encontré el archivo en index.html con ${patron}. ` +
        '¿Compilaste con vite.unico.config.ts? Ese config es el que junta todo ' +
        'en un solo bundle; con el normal quedan trozos aparte y esto no sirve.',
    );
  }
  return encontrado[1];
};

const js = readFileSync(join(salida, 'assets', nombreDe(/src="[./]*assets\/([^"]+\.js)"/)), 'utf8');
const css = readFileSync(join(salida, 'assets', nombreDe(/href="[./]*assets\/([^"]+\.css)"/)), 'utf8');

// Se sacan las etiquetas que apuntan a archivos y se pone el contenido adentro.
//
// Ojo con el reemplazo: `String.replace` con un TEXTO interpreta los `$` del
// reemplazo como referencias ($&, $1, $'…), y un bundle de React está lleno de
// `$`. Con texto plano el resultado sale corrompido y el navegador tira
// "Unexpected token '<'", que no se parece en nada a la causa. Con una función
// de reemplazo eso no pasa: lo que devuelve va tal cual.
const meter = (donde, que) => (html = html.replace(donde, () => que));

// Y `</script>` adentro del código cerraría la etiqueta antes de tiempo. En un
// módulo, `<\/` es lo mismo para el motor de JavaScript y no para el parser
// de HTML.
const seguro = js.replace(/<\/script/gi, '<\\/script');

html = html
  .replace(/\s*<script type="module"[^>]*><\/script>/, '')
  .replace(/\s*<link rel="stylesheet"[^>]*>/, '')
  .replace('<title>comeIA — panel del local</title>', () => '<title>comeIA · demo del local</title>');

meter('</head>', `  <style>${css}</style>\n  </head>`);
// El script va al final del body: el módulo necesita que #root ya exista.
meter('</body>', `  <script type="module">${seguro}</script>\n  </body>`);

if (html.includes('assets/')) {
  throw new Error('Quedó algo apuntando a un archivo de afuera: no es un archivo suelto.');
}

const destino = join(salida, 'comeIA-demo.html');
writeFileSync(destino, html);
console.log(`la demo en un solo archivo: ${destino} (${Math.round(html.length / 1024)} kB)`);
