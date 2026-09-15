/**
 * Vuelca el local de ejemplo a un JSON autocontenido, para la demo estatica.
 * No es parte del producto: se corre a mano cuando hay que regenerar la demo.
 */
import fs from 'node:fs';
import { all } from '../src/db/index.js';
import { listProducts, listCategories, listModifierGroups } from '../src/domain/menu.js';
import { listIngredients, dailyUsage, stockAlerts } from '../src/domain/stock.js';
import { listSuppliers, offersFor } from '../src/domain/procurement.js';
import { listKnowledge } from '../src/domain/knowledge.js';
import { listOrders } from '../src/domain/orders.js';
import {
  menuPerformance,
  laggingProducts,
  salesSummary,
  todayIso,
  daysAgoIso,
} from '../src/domain/analytics.js';
import { parseSqliteDate } from '../src/lib/text.js';

const products = listProducts({ onlyActive: true });

const recipes: Record<string, { ingredient_id: string; qty: number }[]> = {};
for (const row of all<{ product_id: string; ingredient_id: string; qty: number }>(
  'SELECT product_id, ingredient_id, qty FROM recipe_items WHERE product_id IS NOT NULL',
)) {
  (recipes[row.product_id] ??= []).push({ ingredient_id: row.ingredient_id, qty: row.qty });
}

const offers: Record<string, unknown[]> = {};
for (const ingredient of listIngredients()) {
  offers[ingredient.id] = offersFor(ingredient.id).map((o) => ({
    supplier_id: o.supplier.id,
    unit_cents: o.unit_cents,
    pack_size: o.pack_size,
    lead_time_hours: o.lead_time_hours,
  }));
}

const modifierGroups = listModifierGroups();
const productGroups: Record<string, string[]> = {};
for (const row of all<{ product_id: string; group_id: string }>('SELECT * FROM product_modifier_groups')) {
  (productGroups[row.product_id] ??= []).push(row.group_id);
}

const usage = Object.fromEntries(dailyUsage(14));

// Ventas historicas por dia, para el grafico de la semana.
const byDay = all<{ day: string; revenue: number; orders: number }>(
  `SELECT date(created_at) AS day, SUM(total_cents) AS revenue, COUNT(*) AS orders
   FROM orders WHERE status IN ('confirmado','en_preparacion','listo','entregado')
     AND created_at >= datetime('now', '-13 days')
   GROUP BY day ORDER BY day`,
);

/**
 * El servicio del ultimo dia con ventas, expresado en minutos antes del cierre
 * en vez de en fechas absolutas. La demo lo rebasa sobre la hora en que se
 * abre, asi siempre se ve un servicio en curso y los relojes de las comandas
 * tienen sentido.
 */
function buildService() {
  const lastDay = all<{ day: string }>(
    `SELECT date(created_at) AS day FROM orders
     WHERE status IN ('confirmado','en_preparacion','listo','entregado')
     GROUP BY day ORDER BY day DESC LIMIT 1`,
  )[0]?.day;
  if (!lastDay) return { orders: [] };

  // listOrders devuelve una pagina desde que los listados se paginaron.
  const orders = listOrders({ since: `${lastDay} 00:00:00` }, { limite: 200, desde: 0 }).items.filter(
    (o) => o.created_at.startsWith(lastDay),
  );
  const last = Math.max(...orders.map((o) => parseSqliteDate(o.created_at).getTime()));

  // Los tres ultimos quedan abiertos, para que la cocina tenga trabajo real.
  const openStates = ['listo', 'en_preparacion', 'confirmado'];

  return {
    orders: orders
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((o, index, list) => {
        const fromEnd = list.length - 1 - index;
        return {
          id: o.id,
          daily_number: o.daily_number,
          code: o.code,
          channel: o.channel,
          status: fromEnd < openStates.length ? openStates[fromEnd]! : 'entregado',
          service_type: o.service_type,
          table_label: o.table_label,
          note: o.note,
          minutes_ago: Math.round((last - parseSqliteDate(o.created_at).getTime()) / 60_000),
          prep_seconds: o.prep_seconds,
          items: o.items.map((i) => ({
            product_id: i.product_id,
            product_name: i.product_name,
            qty: i.qty,
            unit_price_cents: i.unit_price_cents,
            unit_cost_cents: i.unit_cost_cents,
            modifiers: i.modifiers,
            note: i.note,
          })),
        };
      }),
  };
}

const payload = {
  generated_at: new Date().toISOString(),
  settings: Object.fromEntries(
    all<{ key: string; value: string }>('SELECT key, value FROM settings').map((r) => [r.key, r.value]),
  ),
  categories: listCategories(),
  products: products.map((p) => ({ ...p, modifier_group_ids: productGroups[p.id] ?? [] })),
  modifier_groups: modifierGroups,
  ingredients: listIngredients(),
  recipes,
  suppliers: listSuppliers(),
  offers,
  knowledge: listKnowledge(true),
  daily_usage: usage,
  service: buildService(),
  week: salesSummary(daysAgoIso(6), todayIso()),
  yesterday: salesSummary(daysAgoIso(1), daysAgoIso(1)),
  by_day: byDay,
  performance: menuPerformance(30),
  lagging: laggingProducts(30),
  alerts_snapshot: stockAlerts(),
};

const out = process.argv[2] ?? 'demo-data.json';
fs.writeFileSync(out, JSON.stringify(payload));
console.log(`${out}: ${(fs.statSync(out).size / 1024).toFixed(1)} kB`);
