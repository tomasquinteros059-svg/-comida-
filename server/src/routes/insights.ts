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
import { kitchenBoard, listOrders } from '../domain/orders.js';
import {
  createKnowledge,
  deleteKnowledge,
  listKnowledge,
  updateKnowledge,
} from '../domain/knowledge.js';
import { config } from '../config.js';

export const insightsRouter = Router();

// ── Ventas ──────────────────────────────────────────────────────────────────

insightsRouter.get(
  '/sales',
  route((req) => {
    const from = typeof req.query.from === 'string' ? req.query.from : todayIso();
    const to = typeof req.query.to === 'string' ? req.query.to : from;
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
      open_orders: listOrders({ statuses: ['confirmado', 'en_preparacion'] }).length,
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

insightsRouter.get(
  '/menu-performance',
  route((req) => menuPerformance(req.query.days ? Number(req.query.days) : 30)),
);

insightsRouter.get(
  '/lagging',
  route((req) => laggingProducts(req.query.days ? Number(req.query.days) : 30)),
);

insightsRouter.get(
  '/demand-gaps',
  route((req) => demandGaps(req.query.days ? Number(req.query.days) : 30)),
);

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
