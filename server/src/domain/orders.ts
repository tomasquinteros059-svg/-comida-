import { all, get, jsonParse, run, transaction } from '../db/index.js';
import { newId, shortCode } from '../lib/ids.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { assertProductOrderable, getModifiers } from './menu.js';
import { checkAvailability, consumeForOrder, restoreForOrder, syncProductAvailability } from './stock.js';
import type { CartLine, OrderStatus, PricedLine, ServiceType } from './types.js';

/** Transiciones validas del pedido. Cualquier otra combinacion es un error. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  borrador: ['confirmado', 'cancelado'],
  confirmado: ['en_preparacion', 'cancelado'],
  en_preparacion: ['listo', 'cancelado'],
  listo: ['entregado', 'cancelado'],
  entregado: [],
  cancelado: [],
};

export interface OrderRow {
  id: string;
  code: string;
  daily_number: number;
  channel: string;
  status: OrderStatus;
  service_type: ServiceType;
  table_label: string | null;
  customer_name: string;
  customer_phone: string;
  address: string;
  note: string;
  subtotal_cents: number;
  total_cents: number;
  conversation_id: string | null;
  created_at: string;
  confirmed_at: string | null;
  ready_at: string | null;
  closed_at: string | null;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  qty: number;
  unit_price_cents: number;
  unit_cost_cents: number;
  modifiers: { id: string; name: string; price_cents: number }[];
  note: string;
}

export interface Order extends OrderRow {
  items: OrderItemRow[];
  events?: { status: string; actor: string; note: string; created_at: string }[];
  /** Segundos estimados de preparacion, el mayor de los productos del pedido. */
  prep_seconds?: number;
}

// ── Valorizacion del carrito ────────────────────────────────────────────────

/**
 * Toma lineas del carrito y las valoriza contra la carta vigente.
 * Es la unica fuente de precios: el cliente nunca manda importes.
 */
export function priceCart(lines: CartLine[]): { lines: PricedLine[]; subtotal_cents: number } {
  const priced: PricedLine[] = [];

  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      throw badRequest(`Cantidad invalida para el producto ${line.product_id}`);
    }
    const product = assertProductOrderable(line.product_id);
    const modifiers = getModifiers(line.modifier_ids ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      price_cents: m.price_cents,
    }));
    const unit = product.price_cents + modifiers.reduce((sum, m) => sum + m.price_cents, 0);
    priced.push({
      ...line,
      modifier_ids: line.modifier_ids ?? [],
      note: line.note ?? '',
      product_name: product.name,
      unit_price_cents: unit,
      unit_cost_cents: product.cost_cents,
      modifiers,
      line_total_cents: unit * line.qty,
      available: product.available,
    });
  }

  return {
    lines: priced,
    subtotal_cents: priced.reduce((sum, l) => sum + l.line_total_cents, 0),
  };
}

// ── Lectura ─────────────────────────────────────────────────────────────────

const mapItem = (row: OrderItemRow & { modifiers: string }): OrderItemRow => ({
  ...row,
  modifiers: jsonParse<OrderItemRow['modifiers']>(row.modifiers, []),
});

export function getOrder(id: string, opts: { withEvents?: boolean } = {}): Order | undefined {
  const order = get<OrderRow>('SELECT * FROM orders WHERE id = ? OR code = ?', [id, id]);
  if (!order) return undefined;
  const items = all<OrderItemRow & { modifiers: string }>(
    'SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at',
    [order.id],
  ).map(mapItem);
  const prep = get<{ s: number }>(
    `SELECT MAX(p.prep_seconds) AS s FROM order_items oi
     JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`,
    [order.id],
  );
  const result: Order = { ...order, items, prep_seconds: prep?.s ?? 0 };
  if (opts.withEvents) {
    result.events = all('SELECT status, actor, note, created_at FROM order_events WHERE order_id = ? ORDER BY created_at', [order.id]);
  }
  return result;
}

export function getOrderOrThrow(id: string): Order {
  const order = getOrder(id, { withEvents: true });
  if (!order) throw notFound(`Pedido ${id}`);
  return order;
}

export interface ListOrdersOptions {
  statuses?: OrderStatus[];
  since?: string;
  limit?: number;
  channel?: string;
}

export function listOrders(opts: ListOrdersOptions = {}): Order[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`);
    params.push(...opts.statuses);
  }
  if (opts.since) {
    where.push('created_at >= ?');
    params.push(opts.since);
  }
  if (opts.channel) {
    where.push('channel = ?');
    params.push(opts.channel);
  }
  params.push(opts.limit ?? 100);
  const orders = all<OrderRow>(
    `SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT ?`,
    params,
  );
  if (!orders.length) return [];

  const ids = orders.map((o) => o.id);
  const items = all<OrderItemRow & { modifiers: string }>(
    `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`,
    ids,
  ).map(mapItem);

  return orders.map((order) => ({
    ...order,
    items: items.filter((i) => i.order_id === order.id),
  }));
}

/** Tablero de cocina: lo que hay que cocinar ahora, mas viejo primero. */
export function kitchenBoard(): Order[] {
  return listOrders({ statuses: ['confirmado', 'en_preparacion', 'listo'], limit: 60 }).sort(
    (a, b) => a.created_at.localeCompare(b.created_at),
  );
}

// ── Escritura ───────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  lines: CartLine[];
  channel?: string;
  service_type?: ServiceType;
  table_label?: string | null;
  customer_name?: string;
  customer_phone?: string;
  address?: string;
  note?: string;
  conversation_id?: string | null;
  /** Confirmar de una: el pedido entra derecho a cocina. */
  confirm?: boolean;
  actor?: string;
}

/**
 * Crea el pedido. Si `confirm` es true valida stock, descuenta insumos y lo
 * manda a cocina en una sola transaccion: o entra entero o no entra.
 */
export function createOrder(input: CreateOrderInput): Order {
  if (!input.lines.length) throw badRequest('El pedido no tiene productos');
  const { lines, subtotal_cents } = priceCart(input.lines);

  const unavailable = lines.filter((l) => !l.available);
  if (input.confirm && unavailable.length) {
    throw conflict('Hay productos sin disponibilidad', {
      productos: unavailable.map((l) => l.product_name),
    });
  }

  if (input.confirm) {
    const check = checkAvailability(input.lines);
    if (!check.ok) {
      throw conflict('No alcanza el stock de insumos', {
        faltantes: check.shortages.map((s) => ({
          insumo: s.ingredient_name,
          falta: s.missing,
          unidad: s.unit,
        })),
      });
    }
  }

  const id = newId('ord');
  const code = shortCode('PED');
  const status: OrderStatus = input.confirm ? 'confirmado' : 'borrador';

  transaction(() => {
    run(
      `INSERT INTO orders
        (id, code, daily_number, channel, status, service_type, table_label, customer_name,
         customer_phone, address, note, subtotal_cents, total_cents, conversation_id, confirmed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        code,
        nextDailyNumber(),
        input.channel ?? 'chat',
        status,
        input.service_type ?? 'local',
        input.table_label ?? null,
        input.customer_name ?? '',
        input.customer_phone ?? '',
        input.address ?? '',
        input.note ?? '',
        subtotal_cents,
        subtotal_cents,
        input.conversation_id ?? null,
        input.confirm ? new Date().toISOString() : null,
      ],
    );

    for (const line of lines) {
      run(
        `INSERT INTO order_items
          (id, order_id, product_id, product_name, qty, unit_price_cents, unit_cost_cents, modifiers, note)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          newId('oit'),
          id,
          line.product_id,
          line.product_name,
          line.qty,
          line.unit_price_cents,
          line.unit_cost_cents,
          JSON.stringify(line.modifiers),
          line.note ?? '',
        ],
      );
    }

    logEvent(id, status, input.actor ?? 'chatbot', input.confirm ? 'Pedido confirmado' : 'Pedido creado');
  });

  if (input.confirm) {
    consumeForOrder(id, input.lines);
    syncProductAvailability();
  }

  return getOrderOrThrow(id);
}

/**
 * Numero que se canta en el mostrador. Se reinicia cada dia.
 * Se calcula dentro de la misma transaccion que inserta el pedido, asi que
 * no puede duplicarse (SQLite serializa las escrituras).
 */
export function nextDailyNumber(createdAt?: string): number {
  const day = (createdAt ?? new Date().toISOString()).slice(0, 10);
  const row = get<{ n: number }>(
    "SELECT COALESCE(MAX(daily_number), 0) AS n FROM orders WHERE date(created_at) = ?",
    [day],
  );
  return (row?.n ?? 0) + 1;
}

export function logEvent(orderId: string, status: string, actor = 'sistema', note = ''): void {
  run('INSERT INTO order_events (id, order_id, status, actor, note) VALUES (?,?,?,?,?)', [
    newId('evt'),
    orderId,
    status,
    actor,
    note,
  ]);
}

/** Cambia el estado del pedido respetando la maquina de estados. */
export function advanceOrder(
  orderId: string,
  next: OrderStatus,
  opts: { actor?: string; note?: string } = {},
): Order {
  const order = getOrderOrThrow(orderId);
  if (order.status === next) return order;

  const allowed = TRANSITIONS[order.status];
  if (!allowed.includes(next)) {
    throw conflict(`No se puede pasar de "${order.status}" a "${next}"`, { permitidos: allowed });
  }

  const wasConsumed = order.status !== 'borrador';

  transaction(() => {
    const stamps: string[] = [];
    const params: unknown[] = [next];
    if (next === 'confirmado') stamps.push("confirmed_at = datetime('now')");
    if (next === 'listo') stamps.push("ready_at = datetime('now')");
    if (next === 'entregado' || next === 'cancelado') stamps.push("closed_at = datetime('now')");
    run(
      `UPDATE orders SET status = ?${stamps.length ? `, ${stamps.join(', ')}` : ''} WHERE id = ?`,
      [...params, orderId],
    );
    logEvent(orderId, next, opts.actor ?? 'panel', opts.note ?? '');
  });

  if (next === 'confirmado' && !wasConsumed) {
    const check = checkAvailability(
      order.items.map((i) => ({
        product_id: i.product_id,
        qty: i.qty,
        modifier_ids: i.modifiers.map((m) => m.id),
        note: i.note,
      })),
    );
    if (!check.ok) {
      // Revertimos: el pedido no puede pasar a cocina sin insumos.
      run("UPDATE orders SET status = 'borrador', confirmed_at = NULL WHERE id = ?", [orderId]);
      throw conflict('No alcanza el stock de insumos', {
        faltantes: check.shortages.map((s) => ({ insumo: s.ingredient_name, falta: s.missing })),
      });
    }
    consumeForOrder(
      orderId,
      order.items.map((i) => ({
        product_id: i.product_id,
        qty: i.qty,
        modifier_ids: i.modifiers.map((m) => m.id),
        note: i.note,
      })),
    );
    syncProductAvailability();
  }

  if (next === 'cancelado' && wasConsumed) {
    restoreForOrder(orderId);
    syncProductAvailability();
  }

  return getOrderOrThrow(orderId);
}

/** Ticket de cocina en texto plano, listo para imprimir en comandera. */
export function kitchenTicket(orderId: string): string {
  const order = getOrderOrThrow(orderId);
  const width = 40;
  const line = '-'.repeat(width);
  const title = `PEDIDO #${String(order.daily_number).padStart(3, '0')}`;
  const rows: string[] = [
    title.padStart(Math.floor((width + title.length) / 2)),
    order.code.padStart(Math.floor((width + order.code.length) / 2)),
    line,
    `${order.service_type.toUpperCase()}${order.table_label ? `  MESA ${order.table_label}` : ''}`,
    `${new Date(order.created_at + 'Z').toLocaleString('es-AR')}`,
    order.customer_name ? `Cliente: ${order.customer_name}` : '',
    line,
  ].filter(Boolean);

  for (const item of order.items) {
    rows.push(`${String(item.qty).padStart(2)} x ${item.product_name}`);
    for (const mod of item.modifiers) rows.push(`      + ${mod.name}`);
    if (item.note) rows.push(`      ** ${item.note}`);
  }

  rows.push(line);
  if (order.note) rows.push(`NOTA: ${order.note}`);
  if (order.service_type === 'delivery' && order.address) rows.push(`ENVIO: ${order.address}`);
  return rows.join('\n');
}
