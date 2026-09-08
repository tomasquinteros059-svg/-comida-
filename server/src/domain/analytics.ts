import { all, get } from '../db/index.js';

const SOLD = "o.status IN ('confirmado','en_preparacion','listo','entregado')";

// ── Ventas ──────────────────────────────────────────────────────────────────

export interface SalesSummary {
  from: string;
  to: string;
  orders: number;
  revenue_cents: number;
  cost_cents: number;
  margin_cents: number;
  avg_ticket_cents: number;
  items_sold: number;
  by_channel: { channel: string; orders: number; revenue_cents: number }[];
  by_service_type: { service_type: string; orders: number; revenue_cents: number }[];
  by_hour: { hour: string; orders: number; revenue_cents: number }[];
  top_products: { product_id: string; name: string; qty: number; revenue_cents: number }[];
}

/** `from`/`to` en formato YYYY-MM-DD (inclusive ambos). */
export function salesSummary(from: string, to: string): SalesSummary {
  const range = [`${from} 00:00:00`, `${to} 23:59:59`];

  const totals = get<{ orders: number; revenue: number; cost: number; items: number }>(
    `SELECT COUNT(DISTINCT o.id) AS orders,
            COALESCE(SUM(oi.unit_price_cents * oi.qty), 0) AS revenue,
            COALESCE(SUM(oi.unit_cost_cents  * oi.qty), 0) AS cost,
            COALESCE(SUM(oi.qty), 0) AS items
     FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE ${SOLD} AND o.created_at BETWEEN ? AND ?`,
    range,
  )!;

  const by_channel = all<{ channel: string; orders: number; revenue_cents: number }>(
    `SELECT o.channel, COUNT(*) AS orders, COALESCE(SUM(o.total_cents),0) AS revenue_cents
     FROM orders o WHERE ${SOLD} AND o.created_at BETWEEN ? AND ?
     GROUP BY o.channel ORDER BY revenue_cents DESC`,
    range,
  );

  const by_service_type = all<{ service_type: string; orders: number; revenue_cents: number }>(
    `SELECT o.service_type, COUNT(*) AS orders, COALESCE(SUM(o.total_cents),0) AS revenue_cents
     FROM orders o WHERE ${SOLD} AND o.created_at BETWEEN ? AND ?
     GROUP BY o.service_type ORDER BY revenue_cents DESC`,
    range,
  );

  const by_hour = all<{ hour: string; orders: number; revenue_cents: number }>(
    `SELECT strftime('%H', o.created_at) AS hour, COUNT(*) AS orders,
            COALESCE(SUM(o.total_cents),0) AS revenue_cents
     FROM orders o WHERE ${SOLD} AND o.created_at BETWEEN ? AND ?
     GROUP BY hour ORDER BY hour`,
    range,
  );

  const top_products = all<{ product_id: string; name: string; qty: number; revenue_cents: number }>(
    `SELECT oi.product_id, oi.product_name AS name, SUM(oi.qty) AS qty,
            SUM(oi.unit_price_cents * oi.qty) AS revenue_cents
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE ${SOLD} AND o.created_at BETWEEN ? AND ?
     GROUP BY oi.product_id ORDER BY qty DESC LIMIT 10`,
    range,
  );

  return {
    from,
    to,
    orders: totals.orders,
    revenue_cents: totals.revenue,
    cost_cents: totals.cost,
    margin_cents: totals.revenue - totals.cost,
    avg_ticket_cents: totals.orders ? Math.round(totals.revenue / totals.orders) : 0,
    items_sold: totals.items,
    by_channel,
    by_service_type,
    by_hour,
    top_products,
  };
}

export const todayIso = (): string => new Date().toISOString().slice(0, 10);

export function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── Ingenieria de carta ─────────────────────────────────────────────────────

/**
 * Clasificacion clasica de menu engineering, cruzando popularidad contra margen:
 *   estrella  = se vende mucho y deja mucho  -> destacar
 *   vaca      = se vende mucho, deja poco    -> subir precio / bajar costo
 *   enigma    = deja mucho, se vende poco    -> promocionar / reubicar
 *   perro     = poco y poco                  -> sacar de la carta
 */
export type MenuClass = 'estrella' | 'vaca' | 'enigma' | 'perro';

export interface MenuItemPerformance {
  product_id: string;
  name: string;
  category_name: string | null;
  active: boolean;
  available: boolean;
  price_cents: number;
  cost_cents: number;
  margin_cents: number;
  qty: number;
  revenue_cents: number;
  share: number;
  classification: MenuClass;
  days_since_last_sale: number | null;
  recommendation: string;
}

const RECOMMENDATIONS: Record<MenuClass, string> = {
  estrella: 'Mantener y destacar arriba de la carta.',
  vaca: 'Se vende bien pero deja poco: revisar precio o costo del plato.',
  enigma: 'Deja buen margen pero casi no se pide: subirlo de posicion o promocionarlo.',
  perro: 'Bajo volumen y bajo margen: candidato a salir de la carta.',
};

export function menuPerformance(days = 30): MenuItemPerformance[] {
  const since = `-${days} days`;

  const rows = all<{
    product_id: string;
    name: string;
    category_name: string | null;
    active: number;
    available: number;
    price_cents: number;
    cost_cents: number;
    qty: number;
    revenue_cents: number;
    last_sale: string | null;
  }>(
    `SELECT p.id AS product_id, p.name, c.name AS category_name, p.active, p.available,
            p.price_cents, p.cost_cents,
            COALESCE(SUM(oi.qty), 0) AS qty,
            COALESCE(SUM(oi.unit_price_cents * oi.qty), 0) AS revenue_cents,
            MAX(o.created_at) AS last_sale
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN order_items oi ON oi.product_id = p.id
     LEFT JOIN orders o ON o.id = oi.order_id
       AND o.status IN ('confirmado','en_preparacion','listo','entregado')
       AND o.created_at >= datetime('now', ?)
     WHERE p.active = 1
     GROUP BY p.id
     ORDER BY qty DESC`,
    [since],
  );

  const totalQty = rows.reduce((sum, r) => sum + r.qty, 0);
  // Umbral de popularidad estandar: 70% de la venta media por plato.
  const avgQty = rows.length ? totalQty / rows.length : 0;
  const popularityCut = avgQty * 0.7;
  const margins = rows.map((r) => r.price_cents - r.cost_cents);
  const avgMargin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;

  const now = Date.now();
  return rows.map((row) => {
    const margin = row.price_cents - row.cost_cents;
    const popular = row.qty >= popularityCut && row.qty > 0;
    const profitable = margin >= avgMargin;
    const classification: MenuClass = popular
      ? profitable ? 'estrella' : 'vaca'
      : profitable ? 'enigma' : 'perro';

    const daysSince = row.last_sale
      ? Math.floor((now - new Date(`${row.last_sale}Z`).getTime()) / 86_400_000)
      : null;

    return {
      product_id: row.product_id,
      name: row.name,
      category_name: row.category_name,
      active: row.active === 1,
      available: row.available === 1,
      price_cents: row.price_cents,
      cost_cents: row.cost_cents,
      margin_cents: margin,
      qty: row.qty,
      revenue_cents: row.revenue_cents,
      share: totalQty ? Number((row.qty / totalQty).toFixed(4)) : 0,
      classification,
      days_since_last_sale: daysSince,
      recommendation: RECOMMENDATIONS[classification],
    };
  });
}

export interface LaggingProduct extends MenuItemPerformance {
  reason: string;
}

/**
 * "Productos que se van quedando atras": los que no se venden hace rato o
 * que perdieron volumen frente al periodo anterior.
 */
export function laggingProducts(days = 30): LaggingProduct[] {
  const performance = menuPerformance(days);

  const current = windowSales(`-${days} days`, null);
  const previous = windowSales(`-${days * 2} days`, `-${days} days`);

  const lagging: LaggingProduct[] = [];
  for (const item of performance) {
    const now = current.rates.get(item.product_id) ?? 0;
    const before = previous.rates.get(item.product_id) ?? 0;
    const reasons: string[] = [];

    if (item.qty === 0) {
      reasons.push(
        item.days_since_last_sale === null
          ? `Sin ventas en los ultimos ${days} dias`
          : `Ultima venta hace ${item.days_since_last_sale} dias`,
      );
    } else if (previous.openDays >= 7 && before >= 0.5 && now < before * 0.6) {
      const drop = Math.round((1 - now / before) * 100);
      reasons.push(
        `Cayo ${drop}% por dia contra el periodo anterior ` +
          `(${before.toFixed(1)} -> ${now.toFixed(1)} unidades diarias)`,
      );
    }

    if (item.classification === 'perro' && item.qty > 0) {
      reasons.push('Bajo volumen y bajo margen');
    }
    if (!item.available) reasons.push('Marcado sin disponibilidad');

    if (reasons.length) lagging.push({ ...item, reason: reasons.join('. ') });
  }

  return lagging.sort((a, b) => a.qty - b.qty || b.margin_cents - a.margin_cents);
}

interface WindowSales {
  /** Unidades vendidas por dia abierto, por producto. */
  rates: Map<string, number>;
  openDays: number;
}

/**
 * Ventas por producto en una ventana, normalizadas por dia con actividad.
 * Comparar tasas y no totales evita que un periodo mas corto (porque el local
 * abrio hace poco, o cerro varios dias) parezca una caida de ventas.
 */
function windowSales(from: string, to: string | null): WindowSales {
  const bound = to ? 'AND o.created_at < datetime(\'now\', ?)' : '';
  const params = to ? [from, to] : [from];

  const openDays = get<{ n: number }>(
    `SELECT COUNT(DISTINCT date(o.created_at)) AS n FROM orders o
     WHERE o.status IN ('confirmado','en_preparacion','listo','entregado')
       AND o.created_at >= datetime('now', ?) ${bound}`,
    params,
  )?.n ?? 0;

  const rows = all<{ product_id: string; qty: number }>(
    `SELECT oi.product_id, SUM(oi.qty) AS qty
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status IN ('confirmado','en_preparacion','listo','entregado')
       AND o.created_at >= datetime('now', ?) ${bound}
     GROUP BY oi.product_id`,
    params,
  );

  const divisor = Math.max(1, openDays);
  return { rates: new Map(rows.map((r) => [r.product_id, r.qty / divisor])), openDays };
}

// ── Demanda insatisfecha ────────────────────────────────────────────────────

export interface DemandGap {
  query: string;
  kind: string;
  count: number;
  last_seen: string;
  product_id: string | null;
}

/** Lo que los clientes pidieron y no pudimos vender, agrupado por frecuencia. */
export function demandGaps(days = 30): DemandGap[] {
  return all<DemandGap>(
    `SELECT query, kind, COUNT(*) AS count, MAX(created_at) AS last_seen, product_id
     FROM demand_signals
     WHERE created_at >= datetime('now', ?)
     GROUP BY LOWER(query), kind
     ORDER BY count DESC, last_seen DESC
     LIMIT 50`,
    [`-${days} days`],
  );
}
