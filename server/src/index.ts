import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configProblems, hasLLM, isProduction } from './config.js';
import { closeDb, db } from './db/index.js';
import { rateLimit } from './lib/rateLimit.js';
import { errorHandler, HttpError } from './lib/http.js';
import { chatRouter } from './routes/chat.js';
import { menuRouter } from './routes/menu.js';
import { ordersRouter } from './routes/orders.js';
import { stockRouter } from './routes/stock.js';
import { procurementRouter } from './routes/procurement.js';
import { insightsRouter } from './routes/insights.js';
import { ingestRouter } from './routes/ingest.js';
import { eventStream } from './lib/events.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  db(); // crea el archivo y aplica el esquema en el arranque

  const app = express();

  // Detras de un proxy, req.ip tiene que ser la IP real del cliente o el
  // limite de pedidos se aplica a la del proxy y no sirve para nada.
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  app.use(corsPolicy());
  // El limite alto es para la ingesta de planillas; la valida su propia ruta.
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      engine: hasLLM() ? 'llm' : 'deterministico',
      model: hasLLM() ? config.chatModel : null,
      currency: config.currency,
    });
  });

  // El chat es publico (lo usa el cliente final); el resto es del local.
  // Va con limite: cada turno puede costar una llamada al modelo.
  app.use(
    '/api/chat',
    rateLimit({
      ...config.chatRateLimit,
      message: 'Estas escribiendo muy rapido. Espera unos segundos y volve a intentar.',
    }),
    chatRouter,
  );

  // Stream de cambios del local: el panel y el chat se enteran al instante de
  // un movimiento de stock en vez de esperar al proximo refresco.
  // Va antes del guard general porque EventSource no puede mandar cabeceras:
  // el token viaja por query string, y por eso este stream solo emite el tipo
  // de cambio y una etiqueta corta, nunca datos del pedido.
  app.get('/api/events', requireAdminStream, eventStream);

  app.use('/api', requireAdmin);

  app.use('/api/menu', menuRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/stock', stockRouter);
  app.use('/api/procurement', procurementRouter);
  app.use('/api/ingest', ingestRouter);
  app.use('/api', insightsRouter);

  // En produccion el panel se sirve desde el mismo proceso.
  const webDist = path.resolve(here, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}

/**
 * Cabeceras de seguridad. Se escriben a mano en vez de traer una dependencia:
 * son cuatro, y asi queda a la vista que hace cada una.
 */
function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.set({
    'X-Content-Type-Options': 'nosniff',        // no adivinar el tipo de un archivo
    'X-Frame-Options': 'SAMEORIGIN',            // no embeber el panel en otro sitio
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  // HSTS solo detras de HTTPS: activarlo sobre HTTP deja al navegador sin poder
  // volver a entrar.
  if (isProduction() && _req.secure) {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

/**
 * En produccion, CORS solo para los origenes declarados. El panel se sirve
 * desde este mismo proceso, asi que lo normal es no necesitar ninguno; la
 * lista existe para cuando el chat se embebe en el sitio del local.
 */
function corsPolicy() {
  if (!isProduction()) return cors();
  if (!config.allowedOrigins.length) return cors({ origin: false });
  return cors({ origin: config.allowedOrigins, credentials: false });
}

/** Igual que requireAdmin, pero acepta el token por query string (SSE). */
function requireAdminStream(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!config.adminToken) return next();
  if (req.query.token === config.adminToken) return next();
  return requireAdmin(req, res, next);
}

/** Proteccion simple del panel. Si no hay ADMIN_TOKEN configurado, pasa todo. */
function requireAdmin(req: express.Request, _res: express.Response, next: express.NextFunction) {
  if (!config.adminToken) return next();
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.header('x-admin-token');
  if (token === config.adminToken) return next();
  next(new HttpError(401, 'Falta el token de administración'));
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  // Mejor no arrancar que arrancar abierto: un panel sin token en internet se
  // encuentra solo, y para cuando alguien lo nota ya edito la carta.
  const problems = configProblems();
  if (problems.length) {
    console.error('\nNo puedo arrancar en produccion con esta configuracion:\n');
    for (const problem of problems) console.error(`  · ${problem}`);
    console.error('');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`comeIA escuchando en el puerto ${config.port}`);
    console.log(`  entorno:       ${config.env}`);
    console.log(`  motor de chat: ${hasLLM() ? `LLM (${config.chatModel})` : 'deterministico (sin ANTHROPIC_API_KEY)'}`);
    console.log(`  base de datos: ${config.databasePath}`);
    console.log(`  panel:         ${config.adminToken ? 'protegido con token' : 'ABIERTO (solo desarrollo)'}`);
  });

  // SQLite en modo WAL necesita cerrar bien para dejar el checkpoint hecho.
  // Sin esto, un redeploy puede dejar el .db-wal colgado.
  const shutdown = (signal: string) => {
    console.log(`\n${signal}: cerrando...`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Si alguna conexion no cierra (el stream SSE queda abierto), no esperamos
    // para siempre.
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
