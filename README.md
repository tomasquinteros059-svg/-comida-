# comeya

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

Para producción:

```bash
npm run build && npm start   # todo servido desde :3000
```

### Configuración

Copiá `.env.example` a `.env`. Todo tiene valor por defecto salvo la clave del
modelo:

| Variable | Para qué |
| --- | --- |
| `ANTHROPIC_API_KEY` | Activa el chatbot con Claude. Sin ella funciona el motor determinista. |
| `CHAT_MODEL` | Modelo a usar (por defecto `claude-sonnet-5`). |
| `DATABASE_PATH` | Archivo SQLite. Relativo a la raíz del proyecto. |
| `ADMIN_TOKEN` | Si está seteado, las rutas del panel piden `Authorization: Bearer <token>`. |
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
- **El prompt se rearma en cada turno**, así que un cambio de precio en el panel
  llega al bot en el mensaje siguiente, sin reiniciar nada.
- **Sin `ANTHROPIC_API_KEY` el sistema igual funciona.** Un motor determinista
  (reglas + coincidencia difusa) resuelve pedir, ver el total, sacar un ítem y
  confirmar. Sirve para demostrar el sistema sin red y para que los tests corran
  contra la lógica real de pedido, no contra un mock.

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

37 tests sobre la lógica que no puede fallar:

- **Pedidos**: valorización contra la carta, transiciones de estado válidas e
  inválidas, numeración diaria, comanda de cocina.
- **Stock**: detección de faltantes antes de aceptar, descuento al confirmar,
  devolución al cancelar, disponibilidad manual que sobrevive a la sincronización.
- **Compras**: elección de proveedor según urgencia, compra por packs, aviso
  cuando nadie llega a tiempo, ingreso al stock recién al recibir.
- **Chatbot**: interpretación de cantidades, búsqueda con errores de tipeo, toma
  de pedido punta a punta, rechazo de ids inventados.
- **Analítica**: resumen de ventas, clasificación de la carta, detección de caídas.

Cada archivo corre contra su propia base efímera.

---

## API

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `POST` | `/api/chat` | Un turno de conversación. Público. |
| `GET` | `/api/dashboard` | Todo lo de la pantalla principal en una llamada. |
| `GET` | `/api/orders/kitchen` | Tablero de cocina. |
| `POST` | `/api/orders/:id/status` | Avanza el pedido. |
| `GET` | `/api/orders/:id/ticket` | Comanda en texto plano. |
| `GET/POST/PATCH` | `/api/menu/products` | Carta. |
| `GET` | `/api/stock/alerts` | Qué se está acabando y cuánto dura. |
| `POST` | `/api/procurement/replenish` | Arma las órdenes de compra. |
| `GET` | `/api/lagging`, `/api/menu-performance`, `/api/demand-gaps` | Reportes de carta. |
| `GET/POST/PATCH` | `/api/knowledge` | Lo que el local le enseña al bot. |

Con `ADMIN_TOKEN` seteado, todo salvo `/api/chat` y `/api/health` pide el token.

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

- Autenticación real con usuarios y roles (hoy hay un token compartido).
- Multi-local: el esquema lo soporta, falta el `tenant_id` y el filtrado.
- Canal de WhatsApp: el motor ya es agnóstico del canal, falta el webhook.
- Cobros y medios de pago.
- Impresión directa a comandera (hoy la comanda se genera y se imprime desde el
  navegador).
