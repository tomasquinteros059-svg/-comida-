import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, configProblems, hasLLM, isProduction } from './config.js';
import { closeDb, db } from './db/index.js';
import { errorHandler } from './lib/http.js';
import { requireAuth, requireAuthStream, requirePermiso, type Actor } from './lib/auth.js';
import { authRouter } from './routes/auth.js';
import { whatsappRouter, whatsappEstado } from './routes/whatsapp.js';
import { cobrosRouter, cobrosWebhookRouter } from './routes/cobros.js';
import { limpiarMensajesVistos } from './domain/whatsapp.js';
import { usuariosRouter } from './routes/usuarios.js';
import { registrar } from './domain/users.js';
import { describirPedido } from './lib/bitacora.js';
import { usarMensajesEnCastellano } from './lib/errores-zod.js';
import { purgarConversacionesViejas } from './domain/retencion.js';
import { chatAdminRouter, chatPublicRouter } from './routes/chat.js';
import { menuRouter } from './routes/menu.js';
import { ordersRouter } from './routes/orders.js';
import { stockRouter } from './routes/stock.js';
import { procurementRouter } from './routes/procurement.js';
import { insightsRouter } from './routes/insights.js';
import { ingestRouter } from './routes/ingest.js';
import { eventStream } from './lib/events.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  usarMensajesEnCastellano();
  db(); // crea el archivo y aplica el esquema en el arranque

  const app = express();

  // Detras de un proxy, req.ip tiene que ser la IP real del cliente o el
  // limite de pedidos se aplica a la del proxy y no sirve para nada.
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  app.use(corsPolicy());
  // El cuerpo grande se admite solo donde hace falta: las planillas de la
  // ingesta. Va montado primero porque body-parser no vuelve a leer un cuerpo
  // ya parseado, asi que el limite chico de abajo lo saltea.
  app.use('/api/ingest', express.json({ limit: '4mb' }));
  // El webhook de WhatsApp se firma sobre el cuerpo CRUDO: volver a serializar
  // el objeto ya parseado da otros bytes y la firma no coincidiria nunca.
  app.use(
    '/api/whatsapp',
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as express.Request & { cuerpoCrudo?: Buffer }).cuerpoCrudo = buf;
      },
    }),
  );
  // Todo lo demas, incluida la ruta publica del chat: un mensaje son dos mil
  // caracteres, no cuatro megas.
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      engine: hasLLM() ? 'llm' : 'deterministico',
      model: hasLLM() ? config.chatModel : null,
      currency: config.currency,
    });
  });

  // Mandar un mensaje y preguntar por el motor es lo unico publico del chat.
  // El router deja pasar lo que no reconoce, asi que el resto de /api/chat cae
  // en el guard de mas abajo.
  app.use('/api/chat', chatPublicRouter);

  // Entrar, salir y preguntar quien soy: publico por definicion, porque el
  // panel lo llama antes de tener sesion.
  app.use('/api/auth', authRouter);

  // El webhook de WhatsApp: lo llama Meta, asi que es publico por definicion.
  // Lo unico que lo protege es la firma del cuerpo, que se verifica adentro.
  app.use('/api/whatsapp', whatsappRouter);

  // El aviso de Mercado Pago tambien lo llama un tercero: publico, protegido
  // por su firma, y nunca se cree lo que dice —el estado se consulta.
  app.use('/api/cobros', cobrosWebhookRouter);

  // Stream de cambios del local: el panel y el chat se enteran al instante de
  // un movimiento de stock en vez de esperar al proximo refresco.
  // Va antes del guard general porque EventSource no puede mandar cabeceras:
  // el token viaja por query string, y por eso este stream solo emite el tipo
  // de cambio y una etiqueta corta, nunca datos del pedido.
  app.get('/api/events', requireAuthStream, eventStream);

  app.use('/api', requireAuth);
  app.use('/api', auditarCambios);

  // Cada pantalla pide su permiso. El criterio esta en domain/users.ts: la
  // cocina ve comandas y nada mas, no porque no se le tenga confianza sino
  // porque la facturacion no le sirve para cocinar.
  // Leer o listar conversaciones es del local: los mensajes traen lo que el
  // cliente escribio, y eso no puede quedar del lado publico.
  app.use('/api/chat', requirePermiso('bot'), chatAdminRouter);
  app.use('/api/menu', requirePermiso('carta'), menuRouter);
  app.use('/api/orders', requirePermiso('cocina'), ordersRouter);
  app.use('/api/stock', requirePermiso('stock'), stockRouter);
  app.use('/api/procurement', requirePermiso('compras'), procurementRouter);
  app.use('/api/ingest', requirePermiso('carta'), ingestRouter);
  app.use('/api/usuarios', requirePermiso('usuarios'), usuariosRouter);
  // Cobrar es plata: va con el permiso de ventas.
  app.use('/api/cobros', requirePermiso('ventas'), cobrosRouter);
  // El estado del canal es del que maneja el bot; el webhook de arriba es otra
  // cosa y ya quedo del lado publico.
  app.get('/api/canales/whatsapp', requirePermiso('bot'), (_req, res) => res.json(whatsappEstado()));

  // insightsRouter junta varias pantallas bajo /api, asi que el permiso se
  // pone por camino antes de montarlo.
  for (const camino of ['/api/dashboard', '/api/sales', '/api/menu-performance', '/api/lagging']) {
    app.use(camino, requirePermiso('ventas'));
  }
  for (const camino of ['/api/knowledge', '/api/demand-gaps', '/api/retencion']) {
    app.use(camino, requirePermiso('bot'));
  }
  // Los ajustes los lee todo el mundo (moneda, huso, nombre del local) y los
  // cambia quien maneja el negocio.
  app.use('/api/settings', (req, res, next) =>
    req.method === 'GET' ? next() : requirePermiso('ventas')(req, res, next),
  );
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

/**
 * Deja constancia de todo lo que cambia algo. Se engancha al final del pedido
 * para anotar solo lo que salio bien: un intento rechazado no es un cambio.
 * Las rutas de usuarios y de ingreso escriben su propio detalle, y por eso se
 * saltean aca.
 */
function auditarCambios(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/usuarios') || req.path.startsWith('/auth')) return next();

  const actor: Actor | undefined = req.actor;
  // La ruta se lee ahora: despues de responder, un borrado ya no deja buscar
  // el nombre de lo que se borro.
  const { action, target } = describirPedido(req.method, `${req.baseUrl}${req.path}`.replace(/^\/api/, ''), req.body);
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    try {
      registrar({
        user_id: actor?.id ?? null,
        user_name: actor?.name ?? 'sistema',
        role: actor?.role ?? '',
        action,
        target,
        ip: req.ip ?? '',
      });
    } catch {
      // Anotar no puede tumbar un pedido que ya se respondio bien.
    }
  });
  next();
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

  // Barrido de conversaciones viejas: una al arrancar y una por día. Es lo
  // unico que hace falta para que el plazo configurado se cumpla solo; sin
  // esto, la decision queda escrita y no pasa nada.
  const barrer = () => {
    try {
      const { conversaciones, mensajes, dias } = purgarConversacionesViejas();
      if (conversaciones) {
        console.log(`[retencion] ${conversaciones} conversaciones y ${mensajes} mensajes de mas de ${dias} dias`);
      }
    } catch (err) {
      console.error('[retencion] no se pudo barrer:', err);
    }
  };
  barrer();
  const barrido = setInterval(barrer, 24 * 60 * 60 * 1000);
  barrido.unref();

  // Los ids de mensajes de WhatsApp viejos no sirven: Meta no reintenta
  // despues de un dia, y la tabla crece para siempre si nadie la limpia.
  limpiarMensajesVistos();
  const limpieza = setInterval(() => {
    try {
      limpiarMensajesVistos();
    } catch (err) {
      console.error('[whatsapp] no se pudo limpiar:', err);
    }
  }, 24 * 60 * 60 * 1000);
  limpieza.unref();

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
