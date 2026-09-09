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
if command -v sqlite3 >/dev/null 2>&1; then
  if sqlite3 "${DESTINO}/${ARCHIVO}" "PRAGMA integrity_check;" | grep -q '^ok$'; then
    PEDIDOS="$(sqlite3 "${DESTINO}/${ARCHIVO}" "SELECT COUNT(*) FROM orders;")"
    echo "[$(date '+%F %T')] verificado: la copia abre bien y tiene ${PEDIDOS} pedidos"
  else
    echo "[$(date '+%F %T')] ATENCIÓN: la copia no pasó el chequeo de integridad" >&2
    exit 1
  fi
else
  echo "[$(date '+%F %T')] nota: instalá sqlite3 para que el script verifique la copia"
fi

# Borrar las viejas va último: si algo falló antes, no se toca lo que ya había.
BORRADAS="$(find "$DESTINO" -name 'comeia-*.db' -type f -mtime "+${RETENCION_DIAS}" -print -delete | wc -l)"
[ "$BORRADAS" -gt 0 ] && echo "[$(date '+%F %T')] borradas ${BORRADAS} copias de más de ${RETENCION_DIAS} días"

echo "[$(date '+%F %T')] copias guardadas: $(find "$DESTINO" -name 'comeia-*.db' -type f | wc -l)"
echo
echo "Recordá que un backup que vive en el mismo disco que la base no es un"
echo "backup. Sincronizá ${DESTINO} a otro lado (rclone, scp, S3)."
