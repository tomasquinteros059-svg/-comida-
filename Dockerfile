# ==============================================================================
# comeIA — imagen de produccion.
#
# Un solo proceso sirve la API y el panel ya compilado. La base es un archivo
# SQLite en /app/data, que TIENE que ser un volumen: si no, cada redeploy borra
# las ventas del local.
# ==============================================================================

# ── Etapa de build ────────────────────────────────────────────────────────────
FROM node:22-slim AS build

# better-sqlite3 es un modulo nativo. Suele bajar un binario ya compilado, pero
# si para esta plataforma no hay, lo compila; sin estas herramientas fallaria.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Primero los manifiestos: mientras no cambien, Docker reusa la capa de
# dependencias y el build vuelve a tardar segundos en vez de minutos.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

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

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
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
