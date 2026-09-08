import { all, get, run, toDbBool, transaction } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/http.js';
import type { CartLine, Ingredient } from './types.js';

interface IngredientRow extends Omit<Ingredient, 'perishable'> {
  perishable: number;
}

const mapIngredient = (row: IngredientRow): Ingredient => ({
  ...row,
  perishable: row.perishable === 1,
});

export const listIngredients = (): Ingredient[] =>
  all<IngredientRow>('SELECT * FROM ingredients ORDER BY name').map(mapIngredient);

export function getIngredient(id: string): Ingredient | undefined {
  const row = get<IngredientRow>('SELECT * FROM ingredients WHERE id = ?', [id]);
  return row ? mapIngredient(row) : undefined;
}

export interface IngredientInput {
  name: string;
  unit?: string;
  stock_qty?: number;
  min_qty?: number;
  par_qty?: number;
  cost_cents?: number;
  perishable?: boolean;
}

export function createIngredient(input: IngredientInput): Ingredient {
  const id = newId('ing');
  run(
    `INSERT INTO ingredients (id, name, unit, stock_qty, min_qty, par_qty, cost_cents, perishable)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      id,
      input.name,
      input.unit ?? 'un',
      input.stock_qty ?? 0,
      input.min_qty ?? 0,
      input.par_qty ?? 0,
      input.cost_cents ?? 0,
      toDbBool(input.perishable ?? false),
    ],
  );
  return getIngredient(id)!;
}

export function updateIngredient(id: string, patch: Partial<IngredientInput>): Ingredient {
  const current = getIngredient(id);
  if (!current) throw notFound('Insumo');
  const next = { ...current, ...patch };
  run(
    `UPDATE ingredients SET name = ?, unit = ?, min_qty = ?, par_qty = ?, cost_cents = ?,
       perishable = ?, updated_at = datetime('now') WHERE id = ?`,
    [next.name, next.unit, next.min_qty, next.par_qty, next.cost_cents, toDbBool(next.perishable), id],
  );
  // El stock solo se mueve con movimientos, para que quede trazabilidad.
  if (patch.stock_qty !== undefined && patch.stock_qty !== current.stock_qty) {
    adjustStock(id, patch.stock_qty - current.stock_qty, 'ajuste', { note: 'Ajuste manual' });
  }
  return getIngredient(id)!;
}

// ── Movimientos ─────────────────────────────────────────────────────────────

export interface MovementRef {
  refType?: string;
  refId?: string;
  note?: string;
}

/** Unico camino para modificar stock: siempre deja rastro en stock_movements. */
export function adjustStock(
  ingredientId: string,
  delta: number,
  reason: 'venta' | 'compra' | 'ajuste' | 'merma',
  ref: MovementRef = {},
): void {
  if (delta === 0) return;
  run('UPDATE ingredients SET stock_qty = stock_qty + ?, updated_at = datetime(\'now\') WHERE id = ?', [
    delta,
    ingredientId,
  ]);
  run(
    `INSERT INTO stock_movements (id, ingredient_id, delta, reason, ref_type, ref_id, note)
     VALUES (?,?,?,?,?,?,?)`,
    [newId('mov'), ingredientId, delta, reason, ref.refType ?? null, ref.refId ?? null, ref.note ?? ''],
  );
}

export const listMovements = (ingredientId?: string, limit = 100) =>
  ingredientId
    ? all(
        `SELECT m.*, i.name AS ingredient_name, i.unit FROM stock_movements m
         JOIN ingredients i ON i.id = m.ingredient_id
         WHERE m.ingredient_id = ? ORDER BY m.created_at DESC LIMIT ?`,
        [ingredientId, limit],
      )
    : all(
        `SELECT m.*, i.name AS ingredient_name, i.unit FROM stock_movements m
         JOIN ingredients i ON i.id = m.ingredient_id
         ORDER BY m.created_at DESC LIMIT ?`,
        [limit],
      );

// ── Recetas ─────────────────────────────────────────────────────────────────

export interface RecipeNeed {
  ingredient_id: string;
  ingredient_name: string;
  unit: string;
  qty: number;
  stock_qty: number;
}

/** Insumos (y cantidades) que consume una lista de lineas del carrito. */
export function requirementsFor(lines: CartLine[]): RecipeNeed[] {
  const needs = new Map<string, RecipeNeed>();

  const add = (row: { ingredient_id: string; name: string; unit: string; qty: number; stock_qty: number }, times: number) => {
    const existing = needs.get(row.ingredient_id);
    if (existing) {
      existing.qty += row.qty * times;
      return;
    }
    needs.set(row.ingredient_id, {
      ingredient_id: row.ingredient_id,
      ingredient_name: row.name,
      unit: row.unit,
      qty: row.qty * times,
      stock_qty: row.stock_qty,
    });
  };

  for (const line of lines) {
    const productRows = all<{ ingredient_id: string; name: string; unit: string; qty: number; stock_qty: number }>(
      `SELECT r.ingredient_id, i.name, i.unit, r.qty, i.stock_qty
       FROM recipe_items r JOIN ingredients i ON i.id = r.ingredient_id
       WHERE r.product_id = ?`,
      [line.product_id],
    );
    for (const row of productRows) add(row, line.qty);

    for (const modifierId of line.modifier_ids ?? []) {
      const modRows = all<{ ingredient_id: string; name: string; unit: string; qty: number; stock_qty: number }>(
        `SELECT r.ingredient_id, i.name, i.unit, r.qty, i.stock_qty
         FROM recipe_items r JOIN ingredients i ON i.id = r.ingredient_id
         WHERE r.modifier_id = ?`,
        [modifierId],
      );
      for (const row of modRows) add(row, line.qty);
    }
  }
  return [...needs.values()];
}

export interface ShortageReport {
  ok: boolean;
  shortages: (RecipeNeed & { missing: number })[];
}

/** Verifica si alcanza el stock para preparar estas lineas. */
export function checkAvailability(lines: CartLine[]): ShortageReport {
  const shortages = requirementsFor(lines)
    .filter((need) => need.stock_qty < need.qty)
    .map((need) => ({ ...need, missing: Number((need.qty - need.stock_qty).toFixed(3)) }));
  return { ok: shortages.length === 0, shortages };
}

/** Descuenta los insumos de un pedido confirmado. */
export function consumeForOrder(orderId: string, lines: CartLine[]): void {
  transaction(() => {
    for (const need of requirementsFor(lines)) {
      adjustStock(need.ingredient_id, -need.qty, 'venta', {
        refType: 'order',
        refId: orderId,
        note: 'Consumo por pedido',
      });
    }
  });
}

/** Devuelve al stock lo consumido por un pedido (cancelacion). */
export function restoreForOrder(orderId: string): void {
  const moves = all<{ ingredient_id: string; delta: number }>(
    `SELECT ingredient_id, SUM(delta) AS delta FROM stock_movements
     WHERE ref_type = 'order' AND ref_id = ? AND reason = 'venta'
     GROUP BY ingredient_id`,
    [orderId],
  );
  transaction(() => {
    for (const move of moves) {
      if (move.delta >= 0) continue;
      adjustStock(move.ingredient_id, -move.delta, 'ajuste', {
        refType: 'order',
        refId: orderId,
        note: 'Reposicion por pedido cancelado',
      });
    }
  });
}

// ── Alertas ─────────────────────────────────────────────────────────────────

/**
 * Consumo promedio por dia de cada insumo, calculado sobre los pedidos
 * vendidos y sus recetas.
 *
 * Se mide contra las ventas y no contra stock_movements porque los
 * movimientos solo existen desde que el sistema esta en produccion: un local
 * que acaba de migrar ya tiene historial de pedidos pero todavia no de stock.
 * El divisor son los dias en los que hubo actividad, para no diluir el
 * promedio con los dias que el local estuvo cerrado.
 */
export function dailyUsage(windowDays = 14): Map<string, number> {
  const since = `-${windowDays} days`;
  const openDays = get<{ n: number }>(
    `SELECT COUNT(DISTINCT date(created_at)) AS n FROM orders
     WHERE status IN ('confirmado','en_preparacion','listo','entregado')
       AND created_at >= datetime('now', ?)`,
    [since],
  )?.n ?? 0;
  const divisor = Math.max(1, openDays);

  const rows = all<{ ingredient_id: string; used: number }>(
    `SELECT r.ingredient_id, SUM(r.qty * oi.qty) AS used
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN recipe_items r ON r.product_id = oi.product_id
     WHERE o.status IN ('confirmado','en_preparacion','listo','entregado')
       AND o.created_at >= datetime('now', ?)
     GROUP BY r.ingredient_id`,
    [since],
  );

  return new Map(rows.map((row) => [row.ingredient_id, Math.max(0, row.used) / divisor]));
}

export type AlertLevel = 'agotado' | 'critico' | 'bajo';

export interface StockAlert {
  ingredient: Ingredient;
  level: AlertLevel;
  /** Consumo promedio por dia en la ventana analizada. */
  daily_usage: number;
  /** Dias de cobertura al ritmo actual. null = sin consumo registrado. */
  days_left: number | null;
  /** Cuanto conviene comprar para volver al nivel objetivo. */
  suggested_qty: number;
  /** Productos de la carta que dejan de poder venderse. */
  blocks_products: string[];
}

/**
 * Calcula el estado de reposicion de cada insumo.
 * `windowDays` es la ventana para estimar el consumo diario.
 */
export function stockAlerts(windowDays = 14): StockAlert[] {
  const usage = dailyUsage(windowDays);

  const alerts: StockAlert[] = [];
  for (const ingredient of listIngredients()) {
    const daily = usage.get(ingredient.id) ?? 0;
    const level: AlertLevel | null =
      ingredient.stock_qty <= 0
        ? 'agotado'
        : ingredient.stock_qty <= ingredient.min_qty
          ? 'critico'
          : ingredient.stock_qty <= ingredient.min_qty * 1.5
            ? 'bajo'
            : null;
    if (!level) continue;

    const target = Math.max(ingredient.par_qty, ingredient.min_qty * 2);
    const blocks = all<{ name: string }>(
      `SELECT DISTINCT p.name FROM recipe_items r
       JOIN products p ON p.id = r.product_id
       WHERE r.ingredient_id = ? AND p.active = 1`,
      [ingredient.id],
    ).map((r) => r.name);

    alerts.push({
      ingredient,
      level,
      daily_usage: Number(daily.toFixed(2)),
      days_left: daily > 0 ? Number((ingredient.stock_qty / daily).toFixed(1)) : null,
      suggested_qty: Number(Math.max(0, target - ingredient.stock_qty).toFixed(2)),
      blocks_products: blocks,
    });
  }

  const rank: Record<AlertLevel, number> = { agotado: 0, critico: 1, bajo: 2 };
  return alerts.sort(
    (a, b) => rank[a.level] - rank[b.level] || (a.days_left ?? 99) - (b.days_left ?? 99),
  );
}

/**
 * Marca como no disponibles los productos cuya receta ya no se puede cumplir,
 * y vuelve a habilitar los que si. Se corre despues de cada venta y de cada
 * recepcion de mercaderia, para que la carta del bot nunca mienta.
 *
 * No toca los productos que el local prendio o apago a mano (available_override).
 */
export function syncProductAvailability(): { disabled: string[]; enabled: string[] } {
  // Los productos con override quedan afuera: el local ya decidio por ellos.
  const products = all<{ id: string; name: string; available: number }>(
    'SELECT id, name, available FROM products WHERE active = 1 AND available_override IS NULL',
  );
  const disabled: string[] = [];
  const enabled: string[] = [];

  transaction(() => {
    for (const product of products) {
      const short = all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM recipe_items r
         JOIN ingredients i ON i.id = r.ingredient_id
         WHERE r.product_id = ? AND i.stock_qty < r.qty`,
        [product.id],
      )[0]!.n;
      const hasRecipe = all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM recipe_items WHERE product_id = ?',
        [product.id],
      )[0]!.n;
      if (!hasRecipe) continue; // sin receta cargada no podemos inferir nada

      const shouldBeAvailable = short === 0;
      if (shouldBeAvailable === (product.available === 1)) continue;
      run('UPDATE products SET available = ?, updated_at = datetime(\'now\') WHERE id = ?', [
        toDbBool(shouldBeAvailable),
        product.id,
      ]);
      (shouldBeAvailable ? enabled : disabled).push(product.name);
    }
  });

  return { disabled, enabled };
}
