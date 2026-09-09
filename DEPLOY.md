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

Caddy saca y renueva el certificado solo. En el servidor, `/etc/caddy/Caddyfile`:

```
pedidos.tulocal.com.ar {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Apuntá el registro `A` del dominio a la IP del servidor y listo. Con nginx el
equivalente es un `proxy_pass` más `certbot`; lo único que no puede faltar es
que el proxy mande `X-Forwarded-For` y `X-Forwarded-Proto` (Caddy lo hace solo).

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

`/etc/systemd/system/comeia.service`:

```ini
[Unit]
Description=comeIA
After=network.target

[Service]
Type=simple
User=comeia
WorkingDirectory=/opt/comeia
EnvironmentFile=/opt/comeia/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now comeia
```

`Restart=always` más el cierre ordenado que ya hace el proceso (SIGTERM cierra
SQLite dejando el WAL consolidado) alcanzan para que sobreviva a un reinicio.

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

Toda la operación del local es un archivo. Copiarlo es el backup:

```bash
# Copia consistente aunque el sistema esté funcionando
docker compose exec comeia \
  node -e "const D=require('better-sqlite3');new D(process.env.DATABASE_PATH).backup('/app/data/backup.db').then(()=>process.exit(0))"
docker compose cp comeia:/app/data/backup.db ./backup-$(date +%F).db
```

Ponelo en un cron diario y mandá la copia afuera del servidor. **Un backup que
vive en el mismo disco que la base no es un backup.**

Restaurar es copiar el archivo de vuelta a `/app/data/comeia.db` con el servicio
apagado.

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
