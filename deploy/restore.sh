#!/usr/bin/env bash
#
# Restaura una copia de comeIA. Es la otra mitad de backup.sh, y la que casi
# nadie prueba hasta que la necesita.
#
# Hay tres cosas que hay que hacer bien, y las tres se pasan por alto:
#
#   1. Los permisos. `docker compose cp` deja el archivo como root, pero el
#      proceso corre como `node`. Si no se corrige, el panel arranca, muestra
#      la carta y los pedidos viejos —parece que funcionó— y falla apenas
#      alguien intenta escribir algo: entrar, tomar un pedido, mover stock.
#      Es la peor forma de fallar, porque parece que salió bien.
#
#   2. Los archivos -wal y -shm de la base anterior. Quedan al lado y
#      pertenecen a OTRA base: si se dejan, SQLite mezcla dos historias.
#
#   3. Verificar la copia ANTES de pisar lo que hay.
#
# Uso:
#   ./deploy/restore.sh ./backups/comeia-2026-09-14_0400.db
#
set -euo pipefail

ARCHIVO="${1:-}"
SERVICIO="${SERVICIO:-comeia}"
RUTA_DB="${RUTA_DB:-/app/data/comeia.db}"

if [ -z "$ARCHIVO" ]; then
  echo "Uso: $0 <archivo-de-backup.db>" >&2
  echo "" >&2
  echo "Copias disponibles:" >&2
  ls -1t ./backups/comeia-*.db 2>/dev/null | head -10 >&2 || echo "  (no hay ninguna en ./backups)" >&2
  exit 1
fi

if [ ! -f "$ARCHIVO" ]; then
  echo "No existe el archivo: $ARCHIVO" >&2
  exit 1
fi

decir() { echo "[$(date '+%F %T')] $*"; }

# ── 1. Verificar la copia antes de tocar nada ────────────────────────────────
# Se revisa DENTRO del contenedor, que es donde vive SQLite. Depender de un
# `sqlite3` en el servidor hace que la verificación se saltee justo en el
# servidor donde no está instalado, que es cuando más falta hace.
decir "revisando la copia antes de pisar lo que hay..."

CANDIDATA="$(dirname "$RUTA_DB")/restore-candidata.db"
# Va al volumen de datos y no a /tmp: `docker compose run` levanta OTRO
# contenedor, y lo unico que los dos ven es el volumen.
docker compose cp "$ARCHIVO" "${SERVICIO}:${CANDIDATA}"

docker compose exec -T "$SERVICIO" node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.argv[1], { readonly: true });
  const chequeo = db.pragma('integrity_check', { simple: true });
  if (chequeo !== 'ok') { console.error('integrity_check dijo: ' + chequeo); process.exit(1); }
  const cuenta = (t) => {
    try { return db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; } catch { return 'sin tabla'; }
  };
  console.log('  la copia abre bien:');
  console.log('    pedidos:   ' + cuenta('orders'));
  console.log('    productos: ' + cuenta('products'));
  console.log('    insumos:   ' + cuenta('ingredients'));
  console.log('    usuarios:  ' + cuenta('users'));
  db.close();
" "$CANDIDATA"

# ── 2. Parar el proceso ──────────────────────────────────────────────────────
# Con el local andando no se restaura: SQLite tendría el archivo abierto y el
# resultado sería una base a medio camino.
decir "parando comeIA..."
docker compose stop "$SERVICIO" > /dev/null

# ── 3. Guardar lo que había, por las dudas ───────────────────────────────────
# Restaurar la copia equivocada pasa. Esto da una vuelta atrás.
RESPALDO="/app/data/antes-de-restaurar-$(date +%Y-%m-%d_%H%M).db"
docker compose run --rm --user root --entrypoint sh "$SERVICIO" -c \
  "[ -f '$RUTA_DB' ] && cp '$RUTA_DB' '$RESPALDO' && chown node:node '$RESPALDO' || true" > /dev/null 2>&1 || true
decir "lo que había quedó guardado como $(basename "$RESPALDO")"

# ── 4. Poner la copia, con dueño y sin restos de la base anterior ────────────
decir "restaurando..."
# Sin `|| true` a proposito: si la copia falla, el script tiene que frenar.
# Un restore que falla en silencio deja la base vacia y parece que salio bien.
docker compose run --rm --user root --entrypoint sh "$SERVICIO" -c "
  set -e
  cp '$CANDIDATA' '$RUTA_DB'
  # Los -wal y -shm son de la base que estaba antes: si quedan, SQLite mezcla
  # dos historias distintas.
  rm -f '${RUTA_DB}-wal' '${RUTA_DB}-shm'
  # Sin esto el panel arranca, se ve bien y no deja escribir nada.
  chown node:node '$RUTA_DB'
  chmod 644 '$RUTA_DB'
  rm -f '$CANDIDATA'
" > /dev/null

docker compose start "$SERVICIO" > /dev/null
decir "arrancando..."

# ── 5. Comprobar que se puede ESCRIBIR, no solo leer ─────────────────────────
# Que la carta se vea no prueba nada: el caso malo de esta operación es
# justamente una base que se lee y no se escribe.
for _ in $(seq 1 20); do
  if docker compose exec -T "$SERVICIO" node -e "
      fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))
    " 2>/dev/null; then break; fi
  sleep 1
done

if docker compose exec -T "$SERVICIO" node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH);
  // Escribir de verdad: que la carta se vea no prueba nada.
  db.exec('CREATE TABLE IF NOT EXISTS _prueba_de_escritura (a INTEGER)');
  db.exec('DROP TABLE _prueba_de_escritura');
  const pedidos = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const usuarios = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log('    quedaron ' + pedidos + ' pedidos y ' + usuarios + ' usuarios');
  db.close();
" 2>/dev/null; then
  decir "listo: la base restaurada se lee Y se escribe"
else
  echo "[$(date '+%F %T')] ATENCIÓN: la base quedó de solo lectura." >&2
  echo "  El panel va a mostrar los datos y va a fallar al tomar un pedido." >&2
  echo "  Revisá el dueño del archivo dentro del contenedor:" >&2
  echo "    docker compose exec $SERVICIO ls -la /app/data" >&2
  exit 1
fi

echo
echo "Entrá al panel y revisá que esté lo que esperás antes de abrir el local."
echo "Si restauraste la copia equivocada, la de antes quedó en:"
echo "  $RESPALDO"
