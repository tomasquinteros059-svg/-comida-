# comeIA

Plataforma para locales de comida. Tres piezas que comparten una sola base de datos:

1. **Un chatbot** que toma el pedido conversando y lo deja listo para cocina. Solo
   puede ofrecer lo que realmente hay: los productos, los precios y la
   disponibilidad los lee de la base en cada turno.
2. **Un panel web** para el local: ventas del día, tablero de cocina, gestión de la
   carta, control de stock y entrenamiento del bot.
3. **Un servicio de reposición express** que arma solo las órdenes de compra
   cuando falta un insumo, eligiendo proveedor por plazo y precio (inmediato,
   menos de 24 h, o normal).

---

## Arrancar

```bash
npm install
npm run seed          # carga un local de ejemplo con un mes y medio de ventas
npm run dev           # servidor en :3000, panel en :5173
```

Abrí <http://localhost:5173>. El panel habla con el servidor por proxy, así que
alcanza con esa URL.

Para producción, la guía completa está en **[DEPLOY.md](DEPLOY.md)**: Docker,
HTTPS, backups y qué conviene saber antes de abrirlo al público. La versión
corta:

```bash
cp .env.example .env         # completar ADMIN_TOKEN
docker compose up -d --build
```

> Si venías de una instalación anterior con la base en `data/comeya.db`,
> renombrá el archivo a `data/comeia.db` (o apuntá `DATABASE_PATH` al viejo).
> El esquema no cambió: solo cambió el nombre.

### Configuración

Copiá `.env.example` a `.env`. Todo tiene valor por defecto salvo la clave del
modelo:

| Variable | Para qué |
| --- | --- |
| `ANTHROPIC_API_KEY` | Activa el chatbot con Claude. Sin ella funciona el motor determinista. |
| `CHAT_MODEL` | Modelo a usar (por defecto `claude-sonnet-5`). |
| `DATABASE_PATH` | Archivo SQLite. Relativo a la raíz del proyecto (por defecto `data/comeia.db`). |
| `ADMIN_TOKEN` | Autoriza el alta del primer dueño y sirve de llave de repuesto. Sin esto, el panel queda abierto (solo desarrollo). |
| `LOGIN_RATE_MAX` | Intentos de ingreso por minuto para un mismo usuario (5). |
| `CURRENCY`, `TIMEZONE` | Formato de importes y horarios del local. |

---

## El chatbot

El bot no improvisa: todo lo que hace pasa por herramientas que consultan la base.

| Herramienta | Qué hace |
| --- | --- |
| `buscar_en_carta` | Busca por nombre, ingrediente, categoría o etiqueta. Tolera plurales y errores de tipeo ("milaneza" → "Milanesa"). |
| `ver_carta` | Devuelve la carta agrupada por categoría. |
| `agregar_al_pedido` | Suma un producto. Rechaza lo que no hay y ofrece alternativas. |
| `quitar_del_pedido` / `ver_pedido` | Editan y muestran el pedido en curso. |
| `datos_del_pedido` | Guarda nombre, tipo de servicio, mesa, dirección y teléfono. |
| `confirmar_pedido` | Cierra el pedido, descuenta insumos y lo manda a cocina. |
| `recomendar` | Sugiere por etiqueta o por lo más vendido de los últimos 30 días. |
| `registrar_pedido_no_disponible` | Deja registro de lo que el cliente quiso y no pudimos vender. |

Tres decisiones que sostienen todo esto:

- **Los precios nunca salen del modelo.** El carrito guarda `product_id` y
  cantidad; el importe se calcula contra la carta vigente al confirmar.
- **El prompt se rearma en cada turno** con la carta y el stock del momento, así
  que un cambio hecho en el panel mientras el cliente escribe llega al bot en el
  mensaje siguiente, sin reiniciar nada.
- **Sin `ANTHROPIC_API_KEY` el sistema igual funciona.** Un motor determinista
  (reglas + coincidencia difusa) resuelve pedir, ver el total, sacar un ítem y
  confirmar. Sirve para demostrar el sistema sin red y para que los tests corran
  contra la lógica real de pedido, no contra un mock.

### El bot no puede vender lo que no hay

Tres mecanismos encadenados, del más lento al más fino:

1. **La carta se recalcula sola.** Si el stock no alcanza para la receta de un
   plato, el plato deja de estar disponible y el bot deja de ofrecerlo.
2. **Los carritos abiertos reservan.** Dos clientes chateando a la vez no pueden
   llevarse las mismas últimas unidades: mientras una conversación tiene algo en
   el carrito, esos insumos no están libres para las demás. La reserva se suelta
   sola a los 15 minutos, así que un chat abandonado no congela el stock.
   Al confirmar la comprobación se hace contra el stock real y no contra las
   reservas: el carrito de al lado puede no cerrarse nunca, y el primero que
   confirma se lo lleva, igual que en el mostrador.
3. **Los cambios se avisan en vivo.** `GET /api/events` es un stream SSE que
   emite cada movimiento de stock, cambio de carta o pedido nuevo. El panel y la
   consola del chat se actualizan en el momento en que pasa, sin esperar al
   próximo refresco.

---

## Subir información al bot

El botón **Subir información**, en la pantalla del chatbot, toma un archivo y lo
convierte en datos del local. Reconoce solo por las columnas de qué se trata:

| Archivo | Columnas que busca | Qué hace |
| --- | --- | --- |
| Carta | `nombre`, `precio`, `costo`, `categoría`, `descripción`, `etiquetas` | Crea o actualiza productos, y arma la categoría si no existe. |
| Insumos | `insumo`, `unidad`, `stock`, `mínimo`, `objetivo`, `costo` | Ajusta el stock y los puntos de reposición. |
| Información | `tema`, `contenido` — o un texto con títulos `## Tema` | Alimenta lo que el bot sabe del local. |

Acepta CSV, TSV, TXT y Markdown, hasta 2 MB. Detecta el separador (`,` `;` tab)
y respeta las comillas, así que sirve un export de Excel sin retocar.

Dos cosas que hace a propósito:

- **Lee los precios como los escribe la gente.** `$1.500`, `1.500,50`, `1,500.50`
  y `1500.50` son todos el mismo número. Cuando aparecen los dos separadores el
  último es el decimal; con uno solo se decide por cuántos dígitos le siguen.
- **Nunca aplica sin mostrar.** Primero calcula el plan (qué crea, qué actualiza,
  con el valor viejo y el nuevo, y qué filas no pudo leer) y recién se aplica
  cuando alguien lo confirma. Al aplicar el plan se recalcula del archivo en el
  servidor: no se confía en lo que mandó el navegador.

---

## Cómo funciona el stock

Cada producto tiene una receta: cuánto consume de cada insumo. A partir de eso:

- Al **confirmar** un pedido se descuentan los insumos, con un movimiento
  registrado por cada uno. Al **cancelarlo** se devuelven.
- La carta se recalcula sola: si no alcanza para preparar un plato, deja de estar
  disponible y el bot deja de ofrecerlo.
- Si el local prende o apaga un producto a mano, esa decisión gana: la
  sincronización automática no la pisa (`available_override`).
- El consumo diario se calcula sobre las ventas y sus recetas, dividido por los
  días en que el local **abrió**. Así los lunes cerrados no diluyen el promedio, y
  un local que recién migró ya tiene estimaciones desde el primer día.

Con eso, cada insumo reporta cuántos días le quedan al ritmo actual y qué platos
frena si se acaba.

### Reposición express

`POST /api/procurement/replenish` con una urgencia arma las órdenes de compra:

| Urgencia | Plazo aceptable |
| --- | --- |
| `inmediato` | 4 h |
| `express` | 24 h |
| `normal` | 1 semana |

Para cada insumo faltante elige entre los proveedores que llegan a tiempo el más
barato, compra por packs completos y **agrupa por proveedor** para no mandar diez
pedidos sueltos al mismo lugar. Genera además el mensaje listo para pegar en
WhatsApp.

Cuando ningún proveedor llega en el plazo pedido, igual arma la orden con el más
rápido **pero lo dice**: la respuesta trae `delayed` y la orden queda con una nota.
Es la diferencia entre un sistema que decide en silencio y uno que avisa.

---

## Organizar la carta

`GET /api/menu-performance` clasifica cada plato cruzando popularidad contra
margen:

| Clase | Significa | Qué hacer |
| --- | --- | --- |
| estrella | se vende mucho y deja mucho | destacar arriba |
| vaca | se vende mucho, deja poco | revisar precio o costo |
| enigma | deja mucho, se pide poco | promocionar, subir de posición |
| perro | poco y poco | candidato a salir |

`GET /api/lagging` es el reporte de **los que se van quedando atrás**: los que no
se venden hace tiempo y los que cayeron contra el período anterior. La comparación
usa unidades por día abierto, no totales, para que un mes más corto no parezca una
caída.

`GET /api/demand-gaps` muestra lo que los clientes pidieron y no pudimos vender,
separado entre "sin stock" y "no está en la carta". Es la lista de lo que
conviene reponer o sumar.

---

## Arquitectura

```
server/src/
├─ db/          esquema SQL, conexión y datos de ejemplo
├─ domain/      la lógica: menu, orders, stock, procurement, analytics, knowledge
├─ chat/        prompt, herramientas, motor LLM y motor determinista
├─ routes/      capa HTTP delgada sobre domain/
└─ lib/         ids, dinero, texto, errores

server/scripts/
└─ export-demo.ts   vuelca el local de ejemplo a un JSON autocontenido

web/src/
├─ pages/       Panel, Cocina, Chatbot, Carta, Stock, Compras, Entrenar al bot
├─ components/  primitivas de UI
└─ lib/         cliente HTTP, formato, hook de datos
```

Reglas que se mantienen en todo el código:

- **El dinero es siempre un entero en centavos.** Nunca floats.
- **Las rutas no tienen lógica**: parsean, llaman a `domain/` y devuelven.
- **El stock solo cambia por `adjustStock`**, que deja un movimiento con motivo y
  referencia. No hay forma de mover stock sin dejar rastro.
- **Los pedidos tienen una máquina de estados explícita.** Un salto inválido es un
  error, no un estado raro.
- Un producto que ya se vendió **no se borra**: se desactiva, para no romper el
  histórico de ventas.

### Base de datos

SQLite con `better-sqlite3`, en modo WAL. Es una decisión, no una limitación: un
local de comida tiene un solo proceso escribiendo, las consultas son chicas y la
base entera es un archivo que se copia para hacer backup. Todo el acceso está
detrás de `db/index.ts`, así que migrar a Postgres es cambiar esa capa.

---

## Tests

```bash
npm test
```

59 tests sobre la lógica que no puede fallar:

- **Pedidos**: valorización contra la carta, transiciones de estado válidas e
  inválidas, numeración diaria, comanda de cocina.
- **Stock**: detección de faltantes antes de aceptar, descuento al confirmar,
  devolución al cancelar, disponibilidad manual que sobrevive a la sincronización.
- **Compras**: elección de proveedor según urgencia, compra por packs, aviso
  cuando nadie llega a tiempo, ingreso al stock recién al recibir.
- **Chatbot**: interpretación de cantidades, búsqueda con errores de tipeo, toma
  de pedido punta a punta, rechazo de ids inventados.
- **Reservas**: un carrito abierto retiene stock para los demás, el propio no se
  cuenta dos veces, un carrito viejo lo libera solo, y confirmar compite contra
  el stock real.
- **Ingesta**: lectura de precios en los formatos que usa la gente, detección del
  separador y del tipo de archivo, vista previa que no escribe, y aplicación que
  crea, actualiza y no duplica.
- **Analítica**: resumen de ventas, clasificación de la carta, detección de caídas.

Cada archivo corre contra su propia base efímera.

---

## API

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `POST` | `/api/chat` | Un turno de conversación. **La única ruta pública** junto con `/api/health` y `/api/chat/engine`. |
| `GET` | `/api/dashboard` | Todo lo de la pantalla principal en una llamada. |
| `GET` | `/api/orders/kitchen` | Tablero de cocina. |
| `POST` | `/api/orders/:id/status` | Avanza el pedido. |
| `GET` | `/api/orders/:id/ticket` | Comanda en texto plano. |
| `GET/POST/PATCH` | `/api/menu/products` | Carta. |
| `GET` | `/api/stock/alerts` | Qué se está acabando y cuánto dura. |
| `POST` | `/api/procurement/replenish` | Arma las órdenes de compra. |
| `POST` | `/api/ingest/preview` | Qué cambiaría un archivo, sin tocar nada. |
| `POST` | `/api/ingest/apply` | Aplica el archivo. |
| `GET` | `/api/events` | Stream SSE de cambios (stock, carta, pedidos, compras). |
| `GET` | `/api/lagging`, `/api/menu-performance`, `/api/demand-gaps` | Reportes de carta. |
| `GET/PUT` | `/api/retencion` | Cuánto se guardan las conversaciones. |
| `GET/POST` | `/api/whatsapp` | Webhook de Meta. Público, protegido por firma. |
| `GET/POST` | `/api/cobros` | Cobrar, cierre de caja y links de pago. |
| `GET/POST/PATCH` | `/api/knowledge` | Lo que el local le enseña al bot. |

| `GET/POST/PATCH/DELETE` | `/api/usuarios` | Equipo del local y registro de cambios. Solo el dueño. |
| `POST` | `/api/auth/login`, `/api/auth/logout` | Entrar y salir. |
| `GET` | `/api/auth/me` | Con qué arranca el panel: si hay que crear el primer dueño, si hay que pedir la clave, o quién está adentro. |

### Varios locales

Una instalación puede atender a varios locales. **Cada uno tiene su propio
archivo SQLite**: su carta, sus pedidos, su facturación y sus usuarios.

No hay una columna `local_id` en cada tabla, y eso es a propósito: con una
columna, una sola consulta a la que se le olvidó el filtro muestra los pedidos
de otro local. Es el peor error posible en este producto y no se detecta
mirando la pantalla —los datos se ven bien, solo que son de otro—. Con un
archivo por local ese error no se puede cometer.

A cuál entra cada pedido lo decide el dominio. Qué local es viaja por
`AsyncLocalStorage`, así que el código de negocio no se entera de que esto
existe y no hay ningún parámetro que alguien se pueda olvidar de pasar.

Con un solo local todo funciona exactamente como antes.

### Listados paginados

Los listados largos (pedidos, conversaciones, órdenes de compra, movimientos de
stock, registro de cambios) aceptan `?limite=` y `?desde=` y devuelven:

```json
{ "items": [], "total": 412, "desde": 30, "limite": 30, "hay_mas": true }
```

`total` es cuántas hay, no cuántas vinieron: es lo que permite mostrar
"31–60 de 412" y saber si falta una página.

### Quién ve qué

Cada persona del local entra con su usuario. Los roles están pensados por lo que
cada uno necesita ver, no por jerarquía: la cocina no ve facturación porque no
le sirve para cocinar, y ese es todo el criterio.

| | ventas | carta | stock | compras | cocina | bot | usuarios |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **dueño** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **encargado** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| **cocina** | | | | | ✓ | | |

La navegación se arma con esos permisos, así que cada uno ve solo sus pantallas.

Públicas son tres rutas: mandar un mensaje al chat, el estado del servicio y qué
motor está corriendo. Leer o listar conversaciones **no** es público: los
mensajes traen lo que el cliente escribió.

La clave se guarda con scrypt y sal por usuario. La sesión viaja en una cookie
`HttpOnly`, así un script inyectado en el panel no la puede leer. Cambiarle la
clave a alguien, o darlo de baja, le cierra las sesiones abiertas en el acto.

---

## Verlo en el teléfono

Hay dos maneras, y la primera es la que sirve para trabajar:

**El panel, desde el navegador.** comeIA se usa desde el navegador del
teléfono: se entra a la dirección del servidor y listo. Con *Agregar a la
pantalla de inicio* (Compartir → en iPhone, el menú de tres puntos en Android)
queda un icono igual al de cualquier aplicación, a pantalla completa y sin la
barra del navegador. No hay nada que instalar ni que actualizar: el local abre
el panel y es el del día.

**La demo, armada como APK.** Sirve para mostrarlo sin tener ningún servidor
levantado: lleva los datos de mentira adentro y abre sin internet.

```bash
npm install && npm run build:demo        # compila la demo
cd movil && npm install && node preparar.mjs
cd android && ./gradlew assembleDebug    # necesita el SDK de Android
```

El archivo queda en `movil/android/app/build/outputs/apk/debug/app-debug.apk`.

El SDK de Android son varios gigas, así que también está el atajo: en GitHub,
**Actions → Armar el APK → Run workflow**. Lo compila allá y el archivo queda
para bajar en *Artifacts*, sin instalar nada.

El proyecto de Android no se guarda en el repositorio —lo genera Capacitor
solo, y hay que regenerarlo igual con cada versión—; `preparar.mjs` lo arma, le
copia la demo y le pone el icono.

---

## Demo

`server/scripts/export-demo.ts` vuelca la carta, los insumos, los proveedores y
las métricas del local de ejemplo a un JSON autocontenido, para poder mostrar el
producto sin levantar el servidor:

```bash
npx tsx server/scripts/export-demo.ts demo-data.json
```

Queda fuera de `src/`, así que no entra en el build ni en el bundle del servidor.
El servicio se exporta en minutos antes del cierre en vez de fechas absolutas, de
modo que quien abra la demo siempre vea un servicio en curso con los relojes de
las comandas coherentes.

---

## Lo que falta

- Recuperar la clave por mail: hoy cada uno se la puede cambiar desde el panel,
  pero si la perdió del todo se la cambia el dueño desde **Usuarios**.
- El stream de eventos es un bus en memoria, así que asume un solo proceso. Si
  algún día hay varios, se cambia por Redis y los emisores no se tocan.
- Que el chatbot entienda audios de WhatsApp: hoy toma pedidos por texto y los
  audios se ignoran.
- Plantillas de WhatsApp: Meta solo deja escribirle libremente a alguien dentro
  de las 24 h de su último mensaje. Los avisos de un pedido caen siempre adentro
  de esa ventana, pero para escribirle a un cliente al otro día haría falta una
  plantilla aprobada.
- Cobros con otros medios además de Mercado Pago.
