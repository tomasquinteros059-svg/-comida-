import { all, get, run, toDbBool, transaction } from '../db/index.js';
import { newId, shortCode } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/http.js';
import { adjustStock, stockAlerts, syncProductAvailability } from './stock.js';
import { emit } from '../lib/events.js';
import type { PurchaseStatus, Urgency } from './types.js';

export interface Supplier {
  id: string;
  name: string;
  phone: string;
  email: string;
  express: boolean;
  lead_time_hours: number;
  min_order_cents: number;
  active: boolean;
  note: string;
}

interface SupplierRow extends Omit<Supplier, 'express' | 'active'> {
  express: number;
  active: number;
}

const mapSupplier = (row: SupplierRow): Supplier => ({
  ...row,
  express: row.express === 1,
  active: row.active === 1,
});

export const listSuppliers = (): Supplier[] =>
  all<SupplierRow>('SELECT * FROM suppliers ORDER BY express DESC, lead_time_hours, name').map(mapSupplier);

export function createSupplier(input: Partial<Supplier> & { name: string }): Supplier {
  const id = newId('sup');
  run(
    `INSERT INTO suppliers (id, name, phone, email, express, lead_time_hours, min_order_cents, active, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.name,
      input.phone ?? '',
      input.email ?? '',
      toDbBool(input.express ?? false),
      input.lead_time_hours ?? 24,
      input.min_order_cents ?? 0,
      toDbBool(input.active ?? true),
      input.note ?? '',
    ],
  );
  return mapSupplier(get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [id])!);
}

export function updateSupplier(id: string, patch: Partial<Supplier>): Supplier {
  const current = get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [id]);
  if (!current) throw notFound('Proveedor');
  const next = { ...mapSupplier(current), ...patch };
  run(
    `UPDATE suppliers SET name=?, phone=?, email=?, express=?, lead_time_hours=?,
       min_order_cents=?, active=?, note=? WHERE id=?`,
    [
      next.name, next.phone, next.email, toDbBool(next.express), next.lead_time_hours,
      next.min_order_cents, toDbBool(next.active), next.note, id,
    ],
  );
  return mapSupplier(get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [id])!);
}

export function setSupplierPrice(input: {
  supplier_id: string;
  ingredient_id: string;
  price_cents: number;
  pack_size?: number;
  lead_time_hours?: number | null;
}): void {
  run(
    `INSERT INTO supplier_products (id, supplier_id, ingredient_id, price_cents, pack_size, lead_time_hours)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(supplier_id, ingredient_id) DO UPDATE SET
       price_cents = excluded.price_cents,
       pack_size = excluded.pack_size,
       lead_time_hours = excluded.lead_time_hours`,
    [
      newId('spp'),
      input.supplier_id,
      input.ingredient_id,
      input.price_cents,
      input.pack_size ?? 1,
      input.lead_time_hours ?? null,
    ],
  );
}

// ── Eleccion de proveedor ───────────────────────────────────────────────────

export interface SupplierOffer {
  supplier: Supplier;
  unit_cents: number;
  pack_size: number;
  lead_time_hours: number;
}

const MAX_HOURS: Record<Urgency, number> = { inmediato: 4, express: 24, normal: 168 };

export function offersFor(ingredientId: string): SupplierOffer[] {
  const rows = all<SupplierRow & { price_cents: number; pack_size: number; sp_lead: number | null }>(
    `SELECT s.*, sp.price_cents, sp.pack_size, sp.lead_time_hours AS sp_lead
     FROM supplier_products sp JOIN suppliers s ON s.id = sp.supplier_id
     WHERE sp.ingredient_id = ? AND s.active = 1`,
    [ingredientId],
  );
  return rows.map((row) => {
    const supplier = mapSupplier(row);
    const lead = row.sp_lead ?? supplier.lead_time_hours;
    return {
      supplier,
      unit_cents: Math.round(row.price_cents / Math.max(row.pack_size, 0.0001)),
      pack_size: row.pack_size,
      lead_time_hours: lead,
    };
  });
}

/**
 * Elige proveedor para un insumo dada la urgencia.
 * Prioriza cumplir el plazo; entre los que cumplen, el mas barato.
 * Si ninguno llega a tiempo devuelve el mas rapido, para que el local decida.
 */
export function bestOffer(ingredientId: string, urgency: Urgency = 'normal'): SupplierOffer | null {
  const offers = offersFor(ingredientId);
  if (!offers.length) return null;

  const deadline = MAX_HOURS[urgency];
  const inTime = offers.filter((o) => o.lead_time_hours <= deadline);
  const pool = inTime.length ? inTime : offers;

  return [...pool].sort(
    (a, b) =>
      a.unit_cents - b.unit_cents ||
      a.lead_time_hours - b.lead_time_hours ||
      Number(b.supplier.express) - Number(a.supplier.express),
  )[0]!;
}

// ── Ordenes de compra ───────────────────────────────────────────────────────

export interface PurchaseOrderItem {
  id: string;
  ingredient_id: string;
  ingredient_name: string;
  unit: string;
  qty: number;
  unit_cents: number;
  received_qty: number;
}

export interface PurchaseOrder {
  id: string;
  code: string;
  supplier_id: string;
  supplier_name: string;
  supplier_phone: string;
  status: PurchaseStatus;
  urgency: Urgency;
  total_cents: number;
  eta_at: string | null;
  origin: string;
  origin_ref: string | null;
  note: string;
  created_at: string;
  sent_at: string | null;
  received_at: string | null;
  items: PurchaseOrderItem[];
}

export function getPurchaseOrder(id: string): PurchaseOrder | undefined {
  const row = get<Omit<PurchaseOrder, 'items'>>(
    `SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.id = ? OR po.code = ?`,
    [id, id],
  );
  if (!row) return undefined;
  const items = all<PurchaseOrderItem>(
    `SELECT poi.id, poi.ingredient_id, i.name AS ingredient_name, i.unit,
            poi.qty, poi.unit_cents, poi.received_qty
     FROM purchase_order_items poi JOIN ingredients i ON i.id = poi.ingredient_id
     WHERE poi.purchase_id = ?`,
    [row.id],
  );
  return { ...row, items };
}

export function listPurchaseOrders(statuses?: PurchaseStatus[]): PurchaseOrder[] {
  const where = statuses?.length ? `WHERE po.status IN (${statuses.map(() => '?').join(',')})` : '';
  const rows = all<Omit<PurchaseOrder, 'items'>>(
    `SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     ${where} ORDER BY po.created_at DESC LIMIT 100`,
    statuses ?? [],
  );
  return rows.map((row) => getPurchaseOrder(row.id)!);
}

export interface PurchaseLineInput {
  ingredient_id: string;
  qty: number;
  unit_cents?: number;
}

export function createPurchaseOrder(input: {
  supplier_id: string;
  lines: PurchaseLineInput[];
  urgency?: Urgency;
  origin?: string;
  origin_ref?: string | null;
  note?: string;
}): PurchaseOrder {
  if (!input.lines.length) throw badRequest('La orden de compra no tiene ítems');
  const supplier = get<SupplierRow>('SELECT * FROM suppliers WHERE id = ?', [input.supplier_id]);
  if (!supplier) throw notFound('Proveedor');

  const urgency = input.urgency ?? 'normal';
  const id = newId('poh');
  const code = shortCode('OC');

  const lines = input.lines.map((line) => ({
    ...line,
    unit_cents: line.unit_cents ?? bestOffer(line.ingredient_id, urgency)?.unit_cents ?? 0,
  }));
  const total = lines.reduce((sum, l) => sum + Math.round(l.unit_cents * l.qty), 0);

  const leadHours = mapSupplier(supplier).lead_time_hours;
  const eta = new Date(Date.now() + leadHours * 3600_000).toISOString();

  transaction(() => {
    run(
      `INSERT INTO purchase_orders (id, code, supplier_id, status, urgency, total_cents, eta_at, origin, origin_ref, note)
       VALUES (?,?,?,'borrador',?,?,?,?,?,?)`,
      [id, code, input.supplier_id, urgency, total, eta, input.origin ?? 'manual', input.origin_ref ?? null, input.note ?? ''],
    );
    for (const line of lines) {
      run(
        'INSERT INTO purchase_order_items (id, purchase_id, ingredient_id, qty, unit_cents) VALUES (?,?,?,?,?)',
        [newId('poi'), id, line.ingredient_id, line.qty, line.unit_cents],
      );
    }
  });

  return getPurchaseOrder(id)!;
}

const PO_TRANSITIONS: Record<PurchaseStatus, PurchaseStatus[]> = {
  borrador: ['enviada', 'cancelada'],
  enviada: ['confirmada', 'cancelada'],
  confirmada: ['recibida', 'cancelada'],
  recibida: [],
  cancelada: [],
};

export function advancePurchaseOrder(id: string, next: PurchaseStatus): PurchaseOrder {
  const po = getPurchaseOrder(id);
  if (!po) throw notFound('Orden de compra');
  if (!PO_TRANSITIONS[po.status].includes(next)) {
    throw badRequest(`No se puede pasar de "${po.status}" a "${next}"`);
  }

  const stamp =
    next === 'enviada' ? ", sent_at = datetime('now')"
    : next === 'recibida' ? ", received_at = datetime('now')"
    : '';
  run(`UPDATE purchase_orders SET status = ?${stamp} WHERE id = ?`, [next, po.id]);

  // Al recibir, la mercaderia entra al stock y se reevalua la carta.
  if (next === 'recibida') {
    transaction(() => {
      for (const item of po.items) {
        const qty = item.received_qty > 0 ? item.received_qty : item.qty;
        run('UPDATE purchase_order_items SET received_qty = ? WHERE id = ?', [qty, item.id]);
        adjustStock(item.ingredient_id, qty, 'compra', {
          refType: 'purchase_order',
          refId: po.id,
          note: `Recepcion ${po.code}`,
        });
      }
    });
    syncProductAvailability();
  }

  emit('compras', `${po.code} ${next}`);
  return getPurchaseOrder(po.id)!;
}

export function receiveItem(itemId: string, receivedQty: number): void {
  run('UPDATE purchase_order_items SET received_qty = ? WHERE id = ?', [receivedQty, itemId]);
}

// ── Reposicion automatica ───────────────────────────────────────────────────

export interface ReplenishmentPlan {
  urgency: Urgency;
  purchase_orders: PurchaseOrder[];
  /** Insumos que hay que reponer pero no tienen proveedor cargado. */
  unsourced: { ingredient_id: string; ingredient_name: string; qty: number }[];
  /**
   * Insumos que se pidieron igual, pero cuyo proveedor no llega en el plazo.
   * El local necesita verlos para buscar una alternativa a mano.
   */
  delayed: {
    ingredient_id: string;
    ingredient_name: string;
    supplier_name: string;
    lead_time_hours: number;
    deadline_hours: number;
  }[];
}

/**
 * Arma las ordenes de compra necesarias para volver al nivel objetivo.
 * Agrupa por proveedor para no mandar diez pedidos sueltos al mismo lugar.
 *
 * `urgency` define el plazo aceptable: 'inmediato' (<=4h), 'express' (<=24h)
 * o 'normal' (<=1 semana).
 */
export function planReplenishment(
  options: { urgency?: Urgency; ingredientIds?: string[]; origin?: string; originRef?: string | null } = {},
): ReplenishmentPlan {
  const urgency = options.urgency ?? 'express';
  const alerts = stockAlerts();

  const needed = alerts
    .filter((a) => !options.ingredientIds || options.ingredientIds.includes(a.ingredient.id))
    .filter((a) => a.suggested_qty > 0)
    .map((a) => ({ ingredient: a.ingredient, qty: a.suggested_qty }));

  // Insumos pedidos a mano que quizas no estan en alerta todavia.
  for (const id of options.ingredientIds ?? []) {
    if (needed.some((n) => n.ingredient.id === id)) continue;
    const alert = alerts.find((a) => a.ingredient.id === id);
    if (alert) continue;
    const ing = get<{ id: string; name: string; par_qty: number; min_qty: number; stock_qty: number }>(
      'SELECT id, name, par_qty, min_qty, stock_qty FROM ingredients WHERE id = ?',
      [id],
    );
    if (!ing) continue;
    const target = Math.max(ing.par_qty, ing.min_qty * 2, ing.stock_qty + 1);
    needed.push({ ingredient: ing as never, qty: Number((target - ing.stock_qty).toFixed(2)) });
  }

  const bySupplier = new Map<string, PurchaseLineInput[]>();
  const unsourced: ReplenishmentPlan['unsourced'] = [];
  const delayed: ReplenishmentPlan['delayed'] = [];
  const deadline = MAX_HOURS[urgency];

  for (const need of needed) {
    const offer = bestOffer(need.ingredient.id, urgency);
    if (!offer) {
      unsourced.push({
        ingredient_id: need.ingredient.id,
        ingredient_name: need.ingredient.name,
        qty: need.qty,
      });
      continue;
    }
    if (offer.lead_time_hours > deadline) {
      delayed.push({
        ingredient_id: need.ingredient.id,
        ingredient_name: need.ingredient.name,
        supplier_name: offer.supplier.name,
        lead_time_hours: offer.lead_time_hours,
        deadline_hours: deadline,
      });
    }
    // Se compra por packs completos: nadie vende medio cajon.
    const packs = Math.max(1, Math.ceil(need.qty / offer.pack_size));
    const qty = Number((packs * offer.pack_size).toFixed(2));
    const lines = bySupplier.get(offer.supplier.id) ?? [];
    lines.push({ ingredient_id: need.ingredient.id, qty, unit_cents: offer.unit_cents });
    bySupplier.set(offer.supplier.id, lines);
  }

  const purchase_orders = [...bySupplier.entries()].map(([supplierId, lines]) => {
    const late = delayed.filter((d) =>
      lines.some((line) => line.ingredient_id === d.ingredient_id),
    );
    const note = late.length
      ? `Reposicion automatica (${urgency}). Atencion: este proveedor entrega en ` +
        `${late[0]!.lead_time_hours} h, por encima del plazo pedido (${deadline} h).`
      : `Reposicion automatica (${urgency})`;
    return createPurchaseOrder({
      supplier_id: supplierId,
      lines,
      urgency,
      origin: options.origin ?? 'alerta_stock',
      origin_ref: options.originRef ?? null,
      note,
    });
  });

  return { urgency, purchase_orders, unsourced, delayed };
}

/** Texto listo para pegar en WhatsApp/mail al proveedor. */
export function purchaseOrderMessage(id: string): string {
  const po = getPurchaseOrder(id);
  if (!po) throw notFound('Orden de compra');
  const urgencyLabel: Record<Urgency, string> = {
    inmediato: 'URGENTE - necesitamos entrega inmediata',
    express: 'Entrega en el día (menos de 24 h)',
    normal: 'Entrega estándar',
  };
  const items = po.items.map((i) => `• ${i.ingredient_name}: ${i.qty} ${i.unit}`).join('\n');
  const eta = po.eta_at ? new Date(po.eta_at).toLocaleString('es-AR') : 'a coordinar';
  return [
    `Hola ${po.supplier_name}, necesitamos el siguiente pedido (${po.code}):`,
    '',
    items,
    '',
    urgencyLabel[po.urgency],
    `Fecha estimada de entrega: ${eta}`,
    po.note ? `\nNota: ${po.note}` : '',
    '\n¡Gracias!',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
