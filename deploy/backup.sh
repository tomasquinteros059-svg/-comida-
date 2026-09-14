#!/usr/bin/env bash
#
# Backup de comeIA. Toda la operación del local es un archivo SQLite, así que
# copiarlo es el backup entero.
#
# Usa la API de backup de SQLite y no `cp`: copiar el archivo mientras el
# sistema escribe puede dejar una base a medio camino que parece sana y no lo
# está. Esta forma toma una copia consistente con el local funcionando.
#
# Uso:
#   ./deploy/backup.sh                      # a ./backups
#   ./deploy/backup.sh /mnt/backups         # a otra carpeta
#   RETENCION_DIAS=30 ./deploy/backup.sh    # guardar un mes
#
# En cron, todos los días a las 4 de la mañana:
#   0 4 * * * cd /opt/comeia && ./deploy/backup.sh >> /var/log/comeia-backup.log 2>&1

set -euo pipefail

DESTINO="${1:-./backups}"
RETENCION_DIAS="${RETENCION_DIAS:-14}"
SERVICIO="${SERVICIO:-comeia}"
FECHA="$(date +%Y-%m-%d_%H%M)"
ARCHIVO="comeia-${FECHA}.db"

mkdir -p "$DESTINO"

echo "[$(date '+%F %T')] copiando la base..."

# El backup se arma dentro del contenedor, donde vive la base y está el módulo
# de SQLite, y recién después se trae para afuera.
docker compose exec -T "$SERVICIO" node -e "
  const Database = require('better-sqlite3');
  const db = new Database(process.env.DATABASE_PATH, { readonly: true });
  db.backup('/tmp/backup.db')
    .then(() => { db.close(); process.exit(0); })
    .catch((err) => { console.error(err.message); process.exit(1); });
"

docker compose cp "${SERVICIO}:/tmp/backup.db" "${DESTINO}/${ARCHIVO}"
docker compose exec -T "$SERVICIO" rm -f /tmp/backup.db

TAMANIO="$(du -h "${DESTINO}/${ARCHIVO}" | cut -f1)"
echo "[$(date '+%F %T')] listo: ${DESTINO}/${ARCHIVO} (${TAMANIO})"

# Se verifica la copia antes de dar por bueno el backup: un archivo corrupto
# que nadie revisó es peor que no tener backup, porque da tranquilidad falsa.
#
# La revisión se hace DENTRO del contenedor, que es donde vive SQLite. Antes
# dependía de un `sqlite3` instalado en el servidor, y cuando no estaba el
# script avisaba con una línea y seguía: en un cron esa línea no la lee nadie,
# así que el backup quedaba sin verificar justo donde más falta hacía.
docker compose cp "${DESTINO}/${ARCHIVO}" "${SERVICIO}:/tmp/verificar.db" > /dev/null

if docker compose exec -T "$SERVICIO" node -e "
  const Database = require('better-sqlite3');
  const db = new Database('/tmp/verificar.db', { readonly: true });
  const chequeo = db.pragma('integrity_check', { simple: true });
  if (chequeo !== 'ok') { console.error('integrity_check dijo: ' + chequeo); process.exit(1); }
  const pedidos = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const productos = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  console.log('la copia abre bien: ' + pedidos + ' pedidos, ' + productos + ' productos');
  db.close();
"; then
  :
else
  echo "[$(date '+%F %T')] ATENCIÓN: la copia no pasó el chequeo. NO sirve como backup." >&2
  docker compose exec -T "$SERVICIO" rm -f /tmp/verificar.db 2>/dev/null || true
  rm -f "${DESTINO}/${ARCHIVO}"
  exit 1
fi

docker compose exec -T "$SERVICIO" rm -f /tmp/verificar.db 2>/dev/null || true

# Borrar las viejas va último: si algo falló antes, no se toca lo que ya había.
BORRADAS="$(find "$DESTINO" -name 'comeia-*.db' -type f -mtime "+${RETENCION_DIAS}" -print -delete | wc -l)"
[ "$BORRADAS" -gt 0 ] && echo "[$(date '+%F %T')] borradas ${BORRADAS} copias de más de ${RETENCION_DIAS} días"

echo "[$(date '+%F %T')] copias guardadas: $(find "$DESTINO" -name 'comeia-*.db' -type f | wc -l)"
echo
echo "Recordá que un backup que vive en el mismo disco que la base no es un"
echo "backup. Sincronizá ${DESTINO} a otro lado (rclone, scp, S3)."
echo
echo "Para volver atrás con una de estas copias:"
echo "  ./deploy/restore.sh ${DESTINO}/${ARCHIVO}"
