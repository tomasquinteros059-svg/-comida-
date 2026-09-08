import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { all, run } from '../db/index.js';
import { newId } from '../lib/ids.js';
import {
  adjustStock,
  createIngredient,
  listIngredients,
  listMovements,
  stockAlerts,
  syncProductAvailability,
  updateIngredient,
} from '../domain/stock.js';

export const stockRouter = Router();

const ingredientBody = z.object({
  name: z.string().min(1),
  unit: z.string().optional(),
  stock_qty: z.number().optional(),
  min_qty: z.number().min(0).optional(),
  par_qty: z.number().min(0).optional(),
  cost_cents: z.number().int().min(0).optional(),
  perishable: z.boolean().optional(),
});

stockRouter.get('/ingredients', route(() => listIngredients()));
stockRouter.post('/ingredients', route((req) => createIngredient(ingredientBody.parse(req.body))));
stockRouter.patch(
  '/ingredients/:id',
  route((req) => updateIngredient(req.params.id!, ingredientBody.partial().parse(req.body))),
);

stockRouter.post(
  '/ingredients/:id/movements',
  route((req) => {
    const body = z
      .object({
        delta: z.number(),
        reason: z.enum(['venta', 'compra', 'ajuste', 'merma']).default('ajuste'),
        note: z.string().optional(),
      })
      .parse(req.body);
    adjustStock(req.params.id!, body.delta, body.reason, { refType: 'manual', note: body.note });
    syncProductAvailability();
    return { ok: true };
  }),
);

stockRouter.get(
  '/movements',
  route((req) => listMovements(typeof req.query.ingredient_id === 'string' ? req.query.ingredient_id : undefined)),
);

stockRouter.get('/alerts', route(() => stockAlerts()));

stockRouter.post('/sync-availability', route(() => syncProductAvailability()));

// ── Recetas ─────────────────────────────────────────────────────────────────

stockRouter.get(
  '/recipes/:productId',
  route((req) =>
    all(
      `SELECT r.id, r.ingredient_id, i.name AS ingredient_name, i.unit, r.qty, i.stock_qty
       FROM recipe_items r JOIN ingredients i ON i.id = r.ingredient_id
       WHERE r.product_id = ?`,
      [req.params.productId!],
    ),
  ),
);

stockRouter.put(
  '/recipes/:productId',
  route((req) => {
    const { items } = z
      .object({ items: z.array(z.object({ ingredient_id: z.string(), qty: z.number().positive() })) })
      .parse(req.body);
    run('DELETE FROM recipe_items WHERE product_id = ?', [req.params.productId!]);
    for (const item of items) {
      run('INSERT INTO recipe_items (id, product_id, ingredient_id, qty) VALUES (?,?,?,?)', [
        newId('rcp'),
        req.params.productId!,
        item.ingredient_id,
        item.qty,
      ]);
    }
    syncProductAvailability();
    return { ok: true, items: items.length };
  }),
);
