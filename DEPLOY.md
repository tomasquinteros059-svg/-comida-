# Poner comeIA en internet

Guía para dejarlo andando en un servidor real, con HTTPS y sin perder datos.

---

## Antes de empezar

| Necesitás | Para qué | Costo aproximado |
| --- | --- | --- |
| Un servidor con Docker | Correr la aplicación | VPS de 1 GB alcanza y sobra |
| Un dominio | `pedidos.tulocal.com.ar` | El registro anual |
| Un `ADMIN_TOKEN` | Proteger el panel | Gratis: `openssl rand -base64 32` |
| Una `ANTHROPIC_API_KEY` | El bot con Claude (opcional) | Se paga por uso |

Sin la clave de Anthropic el sistema **funciona igual**: el chatbot usa el motor
determinista. Sirve para arrancar y ver si el local lo adopta antes de poner
plata en el modelo.

---

## Cuánto cuesta el chatbot

El prompt de un local se reenvía en cada llamada al modelo, así que es lo que
más pesa en la factura. En el local de ejemplo mide **2.416 tokens** (las
herramientas del bot más las reglas y la carta).

Ese bloque va **cacheado**: se cobra entero la primera vez y a un décimo del
precio en las llamadas siguientes. Por eso la carta cacheada no lleva las
marcas de stock — van aparte, después del punto de caché, para que una venta no
invalide el prefijo entero.

Un pedido típico son unas 10 llamadas al modelo (cinco mensajes del cliente,
más la vuelta de cada herramienta):

| Modelo | Por pedido | 300 pedidos/mes | 900 pedidos/mes |
| --- | ---: | ---: | ---: |
| Sin clave (determinista) | $0 | $0 | $0 |
| `claude-sonnet-5` | ~$0,037 | ~$11 | ~$33 |
| `claude-opus-5` | ~$0,093 | ~$28 | ~$84 |

Tres cosas que conviene saber antes de elegir:

- **El caché baja la cuenta a la mitad.** Sin él, Opus 5 sale ~$0,19 por pedido
  en vez de ~$0,09. Ya viene puesto; lo que hay que hacer es no romperlo.
- **Haiku no conviene acá.** Es el más barato por token, pero necesita un
  prefijo de 4.096 tokens para cachear y el de un local ronda los 2.400: no
  cachea nunca. Termina costando lo mismo que Sonnet 5 (~$0,038 por pedido)
  siendo un modelo bastante peor. No es una buena compra.
- **Son estimaciones.** Salen de medir el prompt real y contar ~3,5 caracteres
  por token. El número exacto lo da `messages.count_tokens`, y el gasto real
  está en la consola de Anthropic. Los logs del contenedor imprimen los tokens
  de cada llamada:

```
[chat] tokens: 620 sin cache · 0 escritos al cache · 2416 leidos del cache · 143 de salida
```

Si "leidos del cache" queda en cero llamada tras llamada, el caché se rompió y
la factura sube sin que nada avise. Es lo primero que hay que mirar después de
tocar la carta o el prompt.

**Una forma sensata de arrancar:** sin clave, con el motor determinista. Toma
pedidos, entiende cantidades y aguanta errores de tipeo. Cuando veas que el
local lo usa, poné la clave — es cambiar una línea del `.env` y reiniciar.

---

## Opción A — Docker en un VPS (la recomendada)

Es un servicio, un volumen y un proxy que resuelve el HTTPS solo.

### 1. Traer el código y configurar

```bash
git clone <tu-repo> comeia && cd comeia
cp .env.example .env
```

Editá `.env` y completá al menos:

```ini
ADMIN_TOKEN=<pegá acá el resultado de: openssl rand -base64 32>
ANTHROPIC_API_KEY=sk-ant-...    # opcional
TRUST_PROXY=1                    # hay un proxy adelante
TIMEZONE=America/Argentina/Buenos_Aires
```

> **El `ADMIN_TOKEN` no es opcional.** Con `NODE_ENV=production` el proceso se
> niega a arrancar sin él, a propósito: un panel abierto en internet se
> encuentra solo, y para cuando alguien lo nota ya editó la carta.

### 2. Levantar

```bash
docker compose up -d --build
docker compose logs -f comeia      # tiene que decir "panel: protegido con token"
```

Queda escuchando en `127.0.0.1:3000` — solo local. El que mira a internet es el
proxy del paso siguiente.

### 3. HTTPS con Caddy

Caddy saca y renueva el certificado solo, sin cron ni certbot. La configuración
está lista en `deploy/Caddyfile`: cambiá el dominio y copiala.

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # poner tu dominio en la primera línea
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Apuntá el registro `A` del dominio a la IP del servidor antes de recargar**, o
la validación del certificado falla y hay que esperar para reintentar.

Con nginx el equivalente es un `proxy_pass` más `certbot`. Lo único que no puede
faltar en ningún caso: que el proxy mande `X-Forwarded-For` y
`X-Forwarded-Proto`, y que no bufferee la respuesta (el panel usa un stream para
enterarse de los cambios de stock al instante).

### 4. Primer arranque

Entrá a tu dominio. Como la base está vacía, el panel te pide crear **el primer
usuario**: ese es el dueño, ve todo y desde **Usuarios** da de alta al resto del
equipo. Para esa alta inicial te va a pedir el `ADMIN_TOKEN` una sola vez —sin
eso, el primero que encontrara la dirección se quedaría con el local.

De ahí en más cada persona entra con su usuario y su clave, y ve solo lo que le
toca:

| Rol | Qué ve |
|---|---|
| **dueño** | Todo, más la pantalla de usuarios. |
| **encargado** | El local entero: ventas, carta, stock, compras, cocina y bot. Usuarios no. |
| **cocina** | Solo el tablero de comandas. Ni precios ni facturación: no le sirven para cocinar. |

Guardá el `ADMIN_TOKEN` donde guardarías la llave del local. Además de
autorizar el alta inicial, es la llave de repuesto: si el dueño se queda
afuera, se entra con eso desde **Entrar con el token maestro**.

El chat de los clientes funciona sin clave — la protección es solo para la
gestión del local.

La base se crea vacía. **En un local real no corras el seed**: son los datos de
una rotisería de ejemplo. En vez de eso, entrá al panel y subí tu carta desde
**Chatbot → Subir información** con un CSV.

Si querés ver el sistema con datos antes de cargar los tuyos:

```bash
docker compose exec comeia node server/dist/db/seed.js
```

---

## Opción B — Sin Docker (Node + systemd)

```bash
npm ci && npm run build
```

La unidad está en `deploy/comeia.service`:

```bash
sudo cp deploy/comeia.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now comeia
```

`Restart=always` más el cierre ordenado que ya hace el proceso (SIGTERM cierra
SQLite dejando el WAL consolidado) alcanzan para que sobreviva a un reinicio. La
unidad además restringe el proceso a escribir solo su carpeta de datos.

---

## Opción C — Plataformas (Fly.io, Railway, Render)

Andan bien con el `Dockerfile` que ya está, **con una condición**: la base es un
archivo, así que necesitás un disco persistente montado en `/app/data`.

- **Fly.io**: `fly volumes create comeia_data --size 1` y en `fly.toml` un
  `[mounts] source="comeia_data" destination="/app/data"`.
- **Railway / Render**: agregar un volumen apuntado a `/app/data`.

> Sin ese disco, el sistema de archivos es efímero: **cada deploy borra las
> ventas del local.** Es el error más caro que se puede cometer acá, y no avisa
> hasta que ya pasó.

Y como el estado vive en un archivo, corré **una sola instancia**. Escalar a dos
no duplica la capacidad: duplica las bases, cada una con la mitad de los pedidos.

---

## Backups

Toda la operación del local es un archivo. Copiarlo es el backup entero, y el
script ya está hecho:

```bash
./deploy/backup.sh                      # guarda en ./backups
./deploy/backup.sh /mnt/backups         # o donde quieras
RETENCION_DIAS=30 ./deploy/backup.sh    # guardar un mes
```

Usa la API de backup de SQLite en vez de `cp`: copiar el archivo mientras el
local está vendiendo puede dejar una base a medio camino que **parece sana y no
lo está**. Después verifica la copia (`integrity_check` y un conteo de pedidos)
antes de darla por buena, y recién entonces borra las viejas.

En cron, todas las madrugadas:

```cron
0 4 * * * cd /opt/comeia && ./deploy/backup.sh >> /var/log/comeia-backup.log 2>&1
```

**Un backup que vive en el mismo disco que la base no es un backup.** Sincronizá
la carpeta afuera del servidor (`rclone`, `scp`, S3).

### Restaurar

```bash
./deploy/restore.sh ./backups/comeia-2026-09-09_0400.db
```

Copiar el archivo a mano **no alcanza**, y falla de la peor manera: `docker
compose cp` lo deja como `root`, pero el proceso corre como `node`. El panel
arranca, muestra la carta y los pedidos viejos —parece que salió bien— y falla
apenas alguien intenta escribir algo: entrar, tomar un pedido, mover stock.

El script hace las tres cosas que se pasan por alto:

1. Revisa la copia **antes** de pisar lo que hay, y guarda lo anterior por si
   restauraste la equivocada.
2. Corrige el dueño del archivo y borra los `-wal`/`-shm` de la base anterior
   (son de otra historia; si quedan, SQLite las mezcla).
3. Al final comprueba que la base se pueda **escribir**, no solo leer.

> Probá una restauración ahora, con el local todavía cerrado. Un backup que
> nadie restauró no es un backup: es tranquilidad falsa.

---

## Actualizar

```bash
git pull
docker compose up -d --build
```

El esquema se aplica solo al arrancar (`CREATE TABLE IF NOT EXISTS`). Hacé el
backup **antes**, no después.

---

## Cuando algo no anda

| Síntoma | Qué mirar |
| --- | --- |
| No arranca | `docker compose logs comeia`. Si falta `ADMIN_TOKEN`, lo dice con todas las letras. |
| Restauré un backup y el panel muestra los datos pero no deja tomar pedidos | Restauraste copiando el archivo a mano: quedó como `root` y el proceso corre como `node`. Usá `./deploy/restore.sh`, que corrige el dueño y lo comprueba. |
| El panel pide la clave y no la acepta | Tiene que ser idéntica a la del `.env`; ojo con los espacios al copiarla. |
| El bot no usa Claude | Los logs dicen `motor de chat`. Si dice "deterministico", falta `ANTHROPIC_API_KEY`. |
| Todos los pedidos parecen venir de la misma IP | Falta `TRUST_PROXY=1`, y el límite del chat se está aplicando al proxy. |
| Se perdieron datos tras un deploy | El volumen no está montado en `/app/data`. Revisalo **antes** del próximo deploy. |
| El chat corta con 429 | Es el límite. Subí `CHAT_RATE_MAX` si el local tiene mucho movimiento. |

`GET /api/health` responde sin token: sirve para el monitoreo externo.

---

## Los canales y los cobros

Los dos son **opcionales** y el sistema funciona sin ninguno.

### WhatsApp

Es el canal que de verdad usa la gente. El motor del chat es el mismo: toma el
pedido igual venga del web o de WhatsApp.

1. Creá una app de WhatsApp Business en `developers.facebook.com`.
2. Completá `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`
   y una `WHATSAPP_VERIFY_TOKEN` que inventás vos.
3. Dando de alta el webhook, apuntalo a `https://tu-dominio/api/whatsapp` y
   pegá la misma palabra de verificación.

> Las credenciales van por variables de entorno y **no** en la base: la base se
> respalda y esas copias terminan circulando. Un token adentro de un backup que
> anda dando vueltas deja mandar mensajes en nombre del local.

### Cobros

Cobrar a mano —efectivo, débito, transferencia— **funciona sin configurar
nada**, y es la mayoría de lo que pasa en un mostrador. Está en la pantalla
**Caja**, junto con el cierre por medio de pago.

Los links de Mercado Pago son para el que pide por el chat y paga antes de
pasar a buscarlo: completá `MERCADOPAGO_ACCESS_TOKEN`,
`MERCADOPAGO_WEBHOOK_SECRET` y `PUBLIC_URL`, y cargá
`https://tu-dominio/api/cobros/webhook` como URL de notificaciones.

### La comandera de la cocina

Si la impresora térmica está en la red del local, cargá su dirección en
**Cocina → Comandera**. En automático la comanda sale sola al confirmarse el
pedido. Si está apagada, el pedido se toma igual.

---

## Varios locales

Una instalación puede atender a varios. **Cada uno tiene su propio archivo**:
su carta, sus pedidos, su facturación y sus usuarios; no se comparte nada, ni
las claves.

Se dan de alta en **Locales** (solo el dueño) y se rutean por dominio. El local
principal atiende todo lo que no coincida con ningún otro, **mientras no tenga
dominios propios**: así sumar un segundo local nunca tira abajo al primero.

---

## Lo que conviene saber antes de abrirlo al público

Esto anda y se puede usar. Pero hay cosas que todavía no están, y es mejor
saberlas ahora que descubrirlas con el local funcionando:

- **Las conversaciones se borran solas a los 90 días** (configurable en
  **Entrenar al bot → Cuánto se guardan las conversaciones**, y `0` = nunca).
  Las que terminaron en pedido no se tocan: ahí la charla es parte de la venta.
  Revisá el plazo antes de abrir, porque los mensajes traen nombres, teléfonos
  y direcciones de tus clientes.
- **No hay "olvidé mi contraseña" por mail.** Cada uno se puede cambiar la
  clave desde el panel (tocá tu nombre arriba a la derecha), pero para eso hay
  que acordarse de la actual. Si alguien la perdió del todo, se la cambia el
  dueño desde **Usuarios**.
- **El chat es público.** Está limitado por IP, pero cualquiera con la URL puede
  conversar con el bot. Si tenés la clave de Anthropic puesta, eso es consumo.
  Empezá con el límite bajo y subilo mirando el uso real.
- **Los backups no vienen solos.** Hay que configurar el cron.
- **Una sola instancia.** SQLite en un archivo: alcanza de sobra para un local,
  pero no se escala poniendo más copias.
- **Sin cobros.** El pedido llega a la cocina; el pago se resuelve como siempre.
