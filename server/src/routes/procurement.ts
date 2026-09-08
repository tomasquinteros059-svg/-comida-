import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import {
  advancePurchaseOrder,
  bestOffer,
  createPurchaseOrder,
  createSupplier,
  getPurchaseOrder,
  listPurchaseOrders,
  listSuppliers,
  offersFor,
  planReplenishment,
  purchaseOrderMessage,
  receiveItem,
  setSupplierPrice,
  updateSupplier,
} from '../domain/procurement.js';
import { notFound } from '../lib/http.js';

export const procurementRouter = Router();

const urgency = z.enum(['normal', 'express', 'inmediato']);

// ── Proveedores ─────────────────────────────────────────────────────────────

procurementRouter.get('/suppliers', route(() => listSuppliers()));

procurementRouter.post(
  '/suppliers',
  route((req) =>
    createSupplier(
      z
        .object({
          name: z.string().min(1),
          phone: z.string().optional(),
          email: z.string().optional(),
          express: z.boolean().optional(),
          lead_time_hours: z.number().int().min(0).optional(),
          min_order_cents: z.number().int().min(0).optional(),
          note: z.string().optional(),
        })
        .parse(req.body),
    ),
  ),
);

procurementRouter.patch('/suppliers/:id', route((req) => updateSupplier(req.params.id!, req.body ?? {})));

procurementRouter.put(
  '/suppliers/:id/prices',
  route((req) => {
    const body = z
      .object({
        ingredient_id: z.string(),
        price_cents: z.number().int().min(0),
        pack_size: z.number().positive().optional(),
        lead_time_hours: z.number().int().min(0).nullable().optional(),
      })
      .parse(req.body);
    setSupplierPrice({ supplier_id: req.params.id!, ...body });
    return { ok: true };
  }),
);

/** Ofertas disponibles para un insumo, con la mejor segun urgencia. */
procurementRouter.get(
  '/offers/:ingredientId',
  route((req) => ({
    offers: offersFor(req.params.ingredientId!),
    best_express: bestOffer(req.params.ingredientId!, 'express'),
    best_immediate: bestOffer(req.params.ingredientId!, 'inmediato'),
  })),
);

// ── Ordenes de compra ───────────────────────────────────────────────────────

procurementRouter.get(
  '/purchase-orders',
  route((req) =>
    listPurchaseOrders(
      typeof req.query.status === 'string' ? (req.query.status.split(',') as never) : undefined,
    ),
  ),
);

procurementRouter.get(
  '/purchase-orders/:id',
  route((req) => getPurchaseOrder(req.params.id!) ?? Promise.reject(notFound('Orden de compra'))),
);

procurementRouter.get(
  '/purchase-orders/:id/message',
  route((req, res) => {
    res.type('text/plain').send(purchaseOrderMessage(req.params.id!));
  }),
);

procurementRouter.post(
  '/purchase-orders',
  route((req) =>
    createPurchaseOrder(
      z
        .object({
          supplier_id: z.string(),
          lines: z
            .array(
              z.object({
                ingredient_id: z.string(),
                qty: z.number().positive(),
                unit_cents: z.number().int().min(0).optional(),
              }),
            )
            .min(1),
          urgency: urgency.optional(),
          note: z.string().optional(),
        })
        .parse(req.body),
    ),
  ),
);

procurementRouter.post(
  '/purchase-orders/:id/status',
  route((req) => {
    const { status } = z
      .object({ status: z.enum(['borrador', 'enviada', 'confirmada', 'recibida', 'cancelada']) })
      .parse(req.body);
    return advancePurchaseOrder(req.params.id!, status);
  }),
);

procurementRouter.post(
  '/purchase-order-items/:id/receive',
  route((req) => {
    const { received_qty } = z.object({ received_qty: z.number().min(0) }).parse(req.body);
    receiveItem(req.params.id!, received_qty);
    return { ok: true };
  }),
);

/**
 * El "servicio extra": arma automaticamente las ordenes de compra necesarias
 * para cubrir los faltantes, eligiendo proveedores que cumplan el plazo.
 */
procurementRouter.post(
  '/replenish',
  route((req) =>
    planReplenishment(
      z
        .object({
          urgency: urgency.optional(),
          ingredient_ids: z.array(z.string()).optional(),
          origin: z.string().optional(),
        })
        .transform((v) => ({
          urgency: v.urgency,
          ingredientIds: v.ingredient_ids,
          origin: v.origin,
        }))
        .parse(req.body ?? {}),
    ),
  ),
);
