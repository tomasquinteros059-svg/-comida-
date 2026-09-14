# ==============================================================================
# comeIA — imagen de produccion.
#
# Un solo proceso sirve la API y el panel ya compilado. La base es un archivo
# SQLite en /app/data, que TIENE que ser un volumen: si no, cada redeploy borra
# las ventas del local.
# ==============================================================================

# ── Etapa de build ────────────────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Primero los manifiestos: mientras no cambien, Docker reusa la capa de
# dependencias y el build vuelve a tardar segundos en vez de minutos.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

# better-sqlite3 es un modulo nativo. Para linux/amd64 y linux/arm64 con Node 22
# baja un binario ya compilado y no necesita nada mas; en una plataforma sin
# binario publicado hay que compilarlo, y ahi si hacen falta las herramientas.
#
# Por eso se intenta primero y se instala el compilador solo si hizo falta: son
# unos 250 MB y varios minutos que la mayoria de los builds no tiene por que
# pagar. `npm ci` borra node_modules antes de empezar, asi que el segundo
# intento arranca limpio.
RUN npm ci || ( \
      echo "Sin binario precompilado para esta plataforma: compilando." \
   && apt-get update \
   && apt-get install -y --no-install-recommends python3 make g++ \
   && rm -rf /var/lib/apt/lists/* \
   && npm ci )

COPY . .
RUN npm run build

# Se descartan las dependencias de desarrollo para lo que se copia a la imagen
# final: TypeScript, Vite y los tipos no tienen nada que hacer en produccion.
RUN npm prune --omit=dev

# ── Imagen final ──────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/comeia.db

WORKDIR /app

# npm workspaces sube todas las dependencias al node_modules de la raiz: no hay
# un server/node_modules ni un web/node_modules que copiar. Node los encuentra
# igual, porque al resolver sube de carpeta hasta dar con ellos.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# El proceso no corre como root, y la carpeta de datos es suya.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]
EXPOSE 3000

# El healthcheck usa el endpoint que ya existe. Si el proceso deja de responder,
# el orquestador lo reinicia en vez de dejarlo colgado.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Sin sh de por medio: asi SIGTERM llega al proceso y el cierre ordenado de
# SQLite (el checkpoint del WAL) se ejecuta de verdad.
CMD ["node", "server/dist/index.js"]
