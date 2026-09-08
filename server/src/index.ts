import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, hasLLM } from './config.js';
import { db } from './db/index.js';
import { errorHandler, HttpError } from './lib/http.js';
import { chatRouter } from './routes/chat.js';
import { menuRouter } from './routes/menu.js';
import { ordersRouter } from './routes/orders.js';
import { stockRouter } from './routes/stock.js';
import { procurementRouter } from './routes/procurement.js';
import { insightsRouter } from './routes/insights.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  db(); // crea el archivo y aplica el esquema en el arranque

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      engine: hasLLM() ? 'llm' : 'deterministico',
      model: hasLLM() ? config.chatModel : null,
      currency: config.currency,
    });
  });

  // El chat es publico (lo usa el cliente final); el resto es del local.
  app.use('/api/chat', chatRouter);

  app.use('/api', requireAdmin);
  app.use('/api/menu', menuRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/stock', stockRouter);
  app.use('/api/procurement', procurementRouter);
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

/** Proteccion simple del panel. Si no hay ADMIN_TOKEN configurado, pasa todo. */
function requireAdmin(req: express.Request, _res: express.Response, next: express.NextFunction) {
  if (!config.adminToken) return next();
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.header('x-admin-token');
  if (token === config.adminToken) return next();
  next(new HttpError(401, 'Falta el token de administracion'));
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`comeya escuchando en http://localhost:${config.port}`);
    console.log(`  motor de chat: ${hasLLM() ? `LLM (${config.chatModel})` : 'deterministico (sin ANTHROPIC_API_KEY)'}`);
    console.log(`  base de datos: ${config.databasePath}`);
  });
}
