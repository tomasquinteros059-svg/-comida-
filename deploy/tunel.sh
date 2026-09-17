#!/usr/bin/env bash
#
# Una dirección pública con HTTPS para comeIA, sin comprar un dominio.
#
# Para qué sirve: Meta NO deja guardar el webhook si el servidor no contesta
# por HTTPS desde afuera. Sin eso no se puede pasar del paso 3 de la conexión,
# por más que las credenciales estén bien. Esto abre un túnel de Cloudflare y
# te da una dirección `https://algo.trycloudflare.com` que apunta a la comeIA
# que tenés corriendo acá.
#
# PARA PROBAR, NO PARA EL LOCAL. La dirección cambia cada vez que arranca y el
# túnel se cae cuando cerrás esta terminal. Sirve para conectar WhatsApp hoy y
# ver el primer pedido entrar de verdad; para atender todos los días hace falta
# un servidor con dominio (ver deploy/con-https.yml).
#
# Uso:
#   docker compose up -d        # comeIA andando en el puerto 3000
#   ./deploy/tunel.sh
#
set -euo pipefail

PUERTO="${PUERTO:-3000}"
CARPETA="$(cd "$(dirname "$0")" && pwd)"
BIN="$CARPETA/.cloudflared"

decir() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── 1. Que comeIA esté andando ──────────────────────────────────────────────
# Sin esto el túnel abre igual y devuelve 502, que es mucho más difícil de
# entender que "no está levantado".
if ! curl -fs -o /dev/null --max-time 5 "http://127.0.0.1:${PUERTO}/api/health" 2>/dev/null; then
  echo "comeIA no contesta en el puerto ${PUERTO}." >&2
  echo "Levantalo primero:  docker compose up -d" >&2
  exit 1
fi
decir "comeIA contesta en el puerto ${PUERTO}"

# ── 2. cloudflared ──────────────────────────────────────────────────────────
if [ ! -x "$BIN" ]; then
  decir "bajando cloudflared (una sola vez)..."
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)  ARCHIVO=cloudflared-linux-amd64 ;;
    Linux-aarch64) ARCHIVO=cloudflared-linux-arm64 ;;
    Darwin-arm64)  ARCHIVO=cloudflared-darwin-arm64.tgz ;;
    Darwin-x86_64) ARCHIVO=cloudflared-darwin-amd64.tgz ;;
    *) echo "No sé qué binario bajar para $(uname -s)-$(uname -m)." >&2
       echo "Instalalo a mano: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
       exit 1 ;;
  esac

  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/${ARCHIVO}"
  if [[ "$ARCHIVO" == *.tgz ]]; then
    curl -fsSL "$URL" | tar -xz -O cloudflared > "$BIN"
  else
    curl -fsSL -o "$BIN" "$URL"
  fi
  chmod +x "$BIN"
fi

# ── 3. El túnel ─────────────────────────────────────────────────────────────
REGISTRO="$(mktemp)"
trap 'rm -f "$REGISTRO"' EXIT

decir "abriendo el túnel..."
"$BIN" tunnel --url "http://127.0.0.1:${PUERTO}" --no-autoupdate > "$REGISTRO" 2>&1 &
TUNEL=$!
trap 'kill $TUNEL 2>/dev/null || true; rm -f "$REGISTRO"' EXIT INT TERM

# La dirección tarda unos segundos en aparecer en la salida.
DIRECCION=""
for _ in $(seq 1 40); do
  DIRECCION="$(grep -aoE 'https://[a-z0-9-]+\.trycloudflare\.com' "$REGISTRO" | head -1 || true)"
  [ -n "$DIRECCION" ] && break
  # Si el proceso se murió, mostrar por qué en vez de esperar al pedo.
  if ! kill -0 "$TUNEL" 2>/dev/null; then
    echo "El túnel no pudo abrir:" >&2
    tail -5 "$REGISTRO" >&2
    exit 1
  fi
  sleep 1
done

if [ -z "$DIRECCION" ]; then
  echo "El túnel abrió pero no encontré la dirección. Mirá la salida:" >&2
  tail -10 "$REGISTRO" >&2
  exit 1
fi

cat <<FIN

  ────────────────────────────────────────────────────────────────
  El panel, desde cualquier lado:
      ${DIRECCION}

  La dirección que va en Meta (Webhooks → WhatsApp → Editar):
      ${DIRECCION}/api/whatsapp
  ────────────────────────────────────────────────────────────────

  Antes de pegarla en Meta, comprobá que contesta bien:
      node qa/comprobar-webhook.mjs ${DIRECCION}

  Dos cosas para tener en cuenta:

  · El panel queda abierto a internet mientras esto corra. Tiene usuario y
    clave y límite de intentos, pero no lo dejes andando de gusto.
  · La dirección cambia cada vez que arranca esto. Si la cambiás, hay que
    volver a cargarla en Meta.

  Ctrl-C para cerrar el túnel.

FIN

wait "$TUNEL"
