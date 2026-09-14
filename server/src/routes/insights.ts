import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { allSettings, setSetting } from '../db/index.js';
import {
  daysAgoIso,
  demandGaps,
  laggingProducts,
  menuPerformance,
  salesSummary,
  todayIso,
} from '../domain/analytics.js';
import { stockAlerts } from '../domain/stock.js';
import { contarOrdenes, kitchenBoard } from '../domain/orders.js';
import {
  createKnowledge,
  deleteKnowledge,
  listKnowledge,
  updateKnowledge,
} from '../domain/knowledge.js';
import { config } from '../config.js';
import { estadoDeRetencion, fijarDiasDeRetencion, purgarConversacionesViejas } from '../domain/retencion.js';

export const insightsRouter = Router();

/**
 * Ventana en dias de los reportes. Sin esto, `?days=hola` se volvia NaN, la
 * consulta no encontraba nada y la respuesta salia igual: un informe vacio
 * presentado como si fuera la verdad.
 */
const diasSchema = z.coerce.number().int().min(1).max(365).default(30);
const dias = (valor: unknown) => diasSchema.parse(valor ?? undefined);

// ── Ventas ──────────────────────────────────────────────────────────────────

const fechaSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD');

insightsRouter.get(
  '/sales',
  route((req) => {
    const from = req.query.from === undefined ? todayIso() : fechaSchema.parse(req.query.from);
    const to = req.query.to === undefined ? from : fechaSchema.parse(req.query.to);
    return salesSummary(from, to);
  }),
);

/** Todo lo que necesita la pantalla principal, en una sola llamada. */
insightsRouter.get(
  '/dashboard',
  route(() => {
    const today = salesSummary(todayIso(), todayIso());
    const yesterday = salesSummary(daysAgoIso(1), daysAgoIso(1));
    const week = salesSummary(daysAgoIso(6), todayIso());
    const alerts = stockAlerts();
    return {
      today,
      yesterday,
      week,
      revenue_change_pct: yesterday.revenue_cents
        ? Number((((today.revenue_cents - yesterday.revenue_cents) / yesterday.revenue_cents) * 100).toFixed(1))
        : null,
      kitchen: kitchenBoard().length,
      open_orders: contarOrdenes({ statuses: ['confirmado', 'en_preparacion'] }),
      stock_alerts: alerts.slice(0, 8),
      stock_alert_counts: {
        agotado: alerts.filter((a) => a.level === 'agotado').length,
        critico: alerts.filter((a) => a.level === 'critico').length,
        bajo: alerts.filter((a) => a.level === 'bajo').length,
      },
      lagging: laggingProducts(30).slice(0, 6),
      demand_gaps: demandGaps(14).slice(0, 6),
      currency: config.currency,
    };
  }),
);

insightsRouter.get('/menu-performance', route((req) => menuPerformance(dias(req.query.days))));

insightsRouter.get('/lagging', route((req) => laggingProducts(dias(req.query.days))));

insightsRouter.get('/demand-gaps', route((req) => demandGaps(dias(req.query.days))));

// ── Conocimiento del bot ────────────────────────────────────────────────────

insightsRouter.get('/knowledge', route(() => listKnowledge()));

insightsRouter.post(
  '/knowledge',
  route((req) =>
    createKnowledge(
      z
        .object({ topic: z.string().min(1), content: z.string().min(1), priority: z.number().int().optional() })
        .parse(req.body),
    ),
  ),
);

insightsRouter.patch('/knowledge/:id', route((req) => updateKnowledge(req.params.id!, req.body ?? {})));

insightsRouter.delete(
  '/knowledge/:id',
  route((req) => {
    deleteKnowledge(req.params.id!);
    return { ok: true };
  }),
);

// ── Ajustes ─────────────────────────────────────────────────────────────────

insightsRouter.get(
  '/settings',
  route(() => ({ ...allSettings(), currency: config.currency, timezone: config.timezone })),
);

insightsRouter.put(
  '/settings',
  route((req) => {
    const body = z.record(z.string()).parse(req.body ?? {});
    for (const [key, value] of Object.entries(body)) setSetting(key, value);
    return allSettings();
  }),
);

// ── Retención de conversaciones ─────────────────────────────────────────────

/**
 * Los mensajes del chat traen lo que la gente escribió: nombres, teléfonos,
 * direcciones. Esta pantalla es para que el local decida cuánto los guarda, en
 * vez de acumularlos para siempre sin haberlo decidido nunca.
 */
insightsRouter.get('/retencion', route(() => estadoDeRetencion()));

insightsRouter.put(
  '/retencion',
  route((req) => {
    const { dias } = z
      .object({ dias: z.coerce.number().int().min(0).max(3650) })
      .parse(req.body ?? {});
    fijarDiasDeRetencion(dias);
    return estadoDeRetencion();
  }),
);

/** Borrar ahora lo que ya pasó el plazo, sin esperar al barrido diario. */
insightsRouter.post(
  '/retencion/purgar',
  route(() => ({ ...purgarConversacionesViejas(), estado: estadoDeRetencion() })),
);
