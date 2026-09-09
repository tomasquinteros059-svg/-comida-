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

Restaurar es copiar el archivo de vuelta a `/app/data/comeia.db` con el servicio
apagado:

```bash
docker compose down
docker compose cp ./backups/comeia-2026-09-09_0400.db comeia:/app/data/comeia.db
docker compose up -d
```

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
| El panel pide token y no lo acepta | El del `.env` tiene que ser idéntico; ojo con los espacios al pegarlo. |
| El bot no usa Claude | Los logs dicen `motor de chat`. Si dice "deterministico", falta `ANTHROPIC_API_KEY`. |
| Todos los pedidos parecen venir de la misma IP | Falta `TRUST_PROXY=1`, y el límite del chat se está aplicando al proxy. |
| Se perdieron datos tras un deploy | El volumen no está montado en `/app/data`. Revisalo **antes** del próximo deploy. |
| El chat corta con 429 | Es el límite. Subí `CHAT_RATE_MAX` si el local tiene mucho movimiento. |

`GET /api/health` responde sin token: sirve para el monitoreo externo.

---

## Lo que conviene saber antes de abrirlo al público

Esto anda y se puede usar. Pero hay cosas que todavía no están, y es mejor
saberlas ahora que descubrirlas con el local funcionando:

- **No hay usuarios, hay una sola clave.** Todos los empleados comparten el
  mismo `ADMIN_TOKEN` y no queda registro de quién cambió qué. Si el local tiene
  varias personas tocando la carta, esto es lo primero que hay que resolver.
- **El chat es público.** Está limitado por IP, pero cualquiera con la URL puede
  conversar con el bot. Si tenés la clave de Anthropic puesta, eso es consumo.
  Empezá con el límite bajo y subilo mirando el uso real.
- **Los backups no vienen solos.** Hay que configurar el cron.
- **Una sola instancia.** SQLite en un archivo: alcanza de sobra para un local,
  pero no se escala poniendo más copias.
- **Sin cobros.** El pedido llega a la cocina; el pago se resuelve como siempre.
