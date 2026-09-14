import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { leerPagina } from '../lib/paginacion.js';
import {
  comandaEnBytes,
  configDeComandera,
  fijarComandera,
  imprimirComanda,
} from '../domain/comandera.js';
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
    return listOrders(
      {
        statuses,
        since: typeof req.query.since === 'string' ? req.query.since : undefined,
        channel: typeof req.query.channel === 'string' ? req.query.channel : undefined,
      },
      leerPagina(req.query),
    );
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

// ── Comandera ───────────────────────────────────────────────────────────────

/**
 * La comanda impresa directo en la cocina. Hasta ahora alguien tenía que estar
 * mirando la pantalla y apretar; en una cocina con las manos ocupadas eso no
 * pasa y el pedido se pierde.
 */
ordersRouter.get('/comandera/config', route(() => configDeComandera()));

const configComanderaBody = z.object({
  host: z.string().max(200).optional(),
  puerto: z.coerce.number().int().min(1).max(65535).optional(),
  automatica: z.boolean().optional(),
  copias: z.coerce.number().int().min(1).max(5).optional(),
});

ordersRouter.put(
  '/comandera/config',
  route((req) => fijarComandera(configComanderaBody.parse(req.body ?? {}))),
);

/** Imprime un pedido a mano, para cuando la automática está apagada o falló. */
ordersRouter.post(
  '/:id/imprimir',
  route(async (req) => {
    const { copias, abrir_cajon } = z
      .object({ copias: z.coerce.number().int().min(1).max(5).optional(), abrir_cajon: z.boolean().optional() })
      .parse(req.body ?? {});
    return imprimirComanda(req.params.id!, { copias, abrirCajon: abrir_cajon });
  }),
);

/**
 * Los bytes tal como salen a la impresora. Sirve para ver qué se manda cuando
 * una comandera imprime cualquier cosa, que es el problema más común y el más
 * difícil de diagnosticar a ciegas.
 */
ordersRouter.get(
  '/:id/comanda-bytes',
  route((req, res) => {
    const bytes = comandaEnBytes(req.params.id!);
    res.type('text/plain').send(
      bytes
        .toString('latin1')
        .replace(/\x1b/g, '<ESC>')
        .replace(/\x1d/g, '<GS>'),
    );
  }),
);
