# QA contra la pila de verdad

`npm test` corre 291 tests de unidad y no toca ni el contenedor, ni el
navegador, ni la demo. Lo que hay acá es lo otro: las cosas que solo se rompen
cuando las piezas están juntas.

Cada suite está acá porque el bug que la motivó **no lo agarraba ningún test de
unidad**.

## Todo junto

```bash
npm --prefix qa install    # trae playwright; una sola vez
npx playwright install     # y el navegador, si no lo tenés
./qa/correr-todo.sh
```

Son 144 casos en ocho suites, cada una sobre una pila recién levantada. Eso
último importa: sin pila limpia las suites se ensucian entre sí —una le cambia
la clave a un usuario que la siguiente usa, otra agota el límite de intentos a
propósito— y el resultado no dice nada del producto, solo del orden en que se
corrieron.

Las suites viven en `qa/suites/`. Van numeradas en el orden en que conviene
leerlas: acceso, flujo operativo, claves, bitácora, canales, y las tres del
navegador.

## Las sueltas

Necesitan la pila levantada y sembrada:

```bash
docker compose up -d
docker compose exec comeia node server/dist/db/seed.js
```

Y un usuario para entrar (`ana` / `clave-de-prueba`, dueño).

```bash
npx tsx qa/paridad-demo.mts        # la demo contesta lo mismo que el servidor
node qa/secciones.mjs              # el panel y stock en el navegador
node qa/whatsapp-permisos.mjs      # quién puede pedir el diagnóstico
```

`qa/whatsapp-cargado.mjs` necesita además las credenciales puestas, porque
prueba justamente la mitad que empieza cuando el local las carga:

```bash
WHATSAPP_PHONE_NUMBER_ID=111222333 \
WHATSAPP_TOKEN=token-de-mentira \
WHATSAPP_VERIFY_TOKEN=la-palabra-del-local \
WHATSAPP_APP_SECRET=la-clave-secreta-de-la-app \
  docker compose up -d
node qa/whatsapp-cargado.mjs
```

`qa/whatsapp-avisos.mjs` es el circuito entero contra el contenedor: un cliente
escribe, el bot toma el pedido, la cocina lo mueve y al cliente le llega el
aviso. Necesita las credenciales puestas, igual que el anterior.

`qa/whatsapp-desde-el-panel.mjs` no necesita ninguna: prueba justamente
cargarlas desde el panel. Corre con la pila normal.

```bash
node qa/whatsapp-desde-el-panel.mjs
```

## Qué mira cada una, y por qué

**`paridad-demo.mts`** — pide las 21 rutas que el panel pide de verdad a los
dos backends y compara la forma, no los valores. Existe porque la pantalla de
la Carta no abría en la demo: `GET /menu` devolvía los productos anidados
adentro de cada categoría en vez de las tres listas que devuelve la API real,
así que `products` quedaba sin definir y React se caía entero. Los dos
backends andaban bien por separado; lo que estaba mal era el contrato.

**`secciones.mjs`** — que los botones sigan colgados de algo después de mover
las pantallas de lugar, que los enlaces vayan a donde dicen, y que la columna
que no entra en el teléfono se esconda ahí y vuelva en el escritorio.
Reorganizar una pantalla es mover botones, y ahí es donde se rompen.

**`whatsapp-permisos.mjs`** — que la cocina no pueda pedir el diagnóstico. No
devuelve credenciales, pero confirma cuáles están cargadas y cuáles no, y eso
no es de la cocina. También: que el webhook siga siendo público, porque Meta
pega sin cookie.

**`whatsapp-cargado.mjs`** — todo WhatsApp se había probado con las
credenciales vacías, que es la mitad que no le importa al local. Acá están
cargadas: la verificación del webhook, la firma (sin firmar, firmado con otra
clave, y firmado bien pero con el cuerpo cambiado), el reintento de Meta que no
puede duplicar el pedido, y el diagnóstico con los cuatro pasos.

Esta es la que encontró el peor bug de todos: **las credenciales no llegaban
al contenedor**. `docker-compose.yml` no las listaba, y el `.env` solo sirve
para completar valores dentro de ese archivo —no entra solo al contenedor—.
El local podía cargar las cuatro credenciales bien, reiniciar, y el panel le
seguía diciendo que faltaban las cuatro, sin manera de darse cuenta por qué.

**`whatsapp-desde-el-panel.mjs`** — conectar WhatsApp sin tocar el servidor,
que es el caso del dueño del local: no tiene SSH y no tiene por qué tenerlo.
Los tres casos que importan no son que funcione, sino que **el token no quede
legible en la base** —se respalda todas las noches y esas copias circulan—,
que el panel nunca devuelva lo que guardó, y que una variable de entorno le
siga ganando a lo cargado desde el panel.

**`whatsapp-avisos.mjs`** — el circuito completo: el cuerpo crudo que firma
Meta, el pedido que llega al panel, el aviso que sale de un cambio de estado
hecho desde la cocina. El caso que más importa es el que comprueba que el
pedido llega a "listo" **aunque Meta no conteste**: un aviso que no sale es una
molestia, un pedido que no avanza es el local parado.
