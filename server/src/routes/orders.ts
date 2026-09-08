import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import {
  advanceOrder,
  createOrder,
  getOrderOrThrow,
  kitchenBoard,
  kitchenTicket,
  listOrders,
  priceCart,
} from '../domain/orders.js';
import type { OrderStatus } from '../domain/types.js';

export const ordersRouter = Router();

const lineSchema = z.object({
  product_id: z.string(),
  qty: z.number().int().min(1),
  modifier_ids: z.array(z.string()).default([]),
  note: z.string().default(''),
});

const statusSchema = z.enum([
  'borrador',
  'confirmado',
  'en_preparacion',
  'listo',
  'entregado',
  'cancelado',
]);

ordersRouter.get(
  '/',
  route((req) => {
    const statuses = typeof req.query.status === 'string'
      ? (req.query.status.split(',') as OrderStatus[])
      : undefined;
    return listOrders({
      statuses,
      since: typeof req.query.since === 'string' ? req.query.since : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
  }),
);

/** Tablero de cocina (KDS). */
ordersRouter.get('/kitchen', route(() => kitchenBoard()));

ordersRouter.get('/:id', route((req) => getOrderOrThrow(req.params.id!)));

ordersRouter.get(
  '/:id/ticket',
  route((req, res) => {
    res.type('text/plain').send(kitchenTicket(req.params.id!));
  }),
);

ordersRouter.post(
  '/quote',
  route((req) => {
    const { lines } = z.object({ lines: z.array(lineSchema) }).parse(req.body);
    return priceCart(lines);
  }),
);

ordersRouter.post(
  '/',
  route((req) =>
    createOrder(
      z
        .object({
          lines: z.array(lineSchema).min(1),
          channel: z.string().optional(),
          service_type: z.enum(['local', 'takeaway', 'delivery']).optional(),
          table_label: z.string().nullable().optional(),
          customer_name: z.string().optional(),
          customer_phone: z.string().optional(),
          address: z.string().optional(),
          note: z.string().optional(),
          confirm: z.boolean().optional(),
          actor: z.string().optional(),
        })
        .parse(req.body),
    ),
  ),
);

ordersRouter.post(
  '/:id/status',
  route((req) => {
    const { status, actor, note } = z
      .object({ status: statusSchema, actor: z.string().optional(), note: z.string().optional() })
      .parse(req.body);
    return advanceOrder(req.params.id!, status, { actor, note });
  }),
);
