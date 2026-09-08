import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import {
  attachModifierGroup,
  createCategory,
  createProduct,
  deleteProduct,
  getProductOrThrow,
  listCategories,
  listModifierGroups,
  listProducts,
  menuAsText,
  reorderProducts,
  updateCategory,
  updateProduct,
} from '../domain/menu.js';

export const menuRouter = Router();

const productBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category_id: z.string().nullable().optional(),
  price_cents: z.number().int().min(0),
  cost_cents: z.number().int().min(0).optional(),
  sku: z.string().nullable().optional(),
  active: z.boolean().optional(),
  available: z.boolean().optional(),
  available_override: z.boolean().nullable().optional(),
  position: z.number().int().optional(),
  prep_seconds: z.number().int().min(0).optional(),
  tags: z.array(z.string()).optional(),
  allergens: z.array(z.string()).optional(),
  image_url: z.string().nullable().optional(),
});

menuRouter.get(
  '/',
  route((req) => ({
    categories: listCategories(),
    products: listProducts({ onlyActive: req.query.all === undefined }),
    modifier_groups: listModifierGroups(),
  })),
);

menuRouter.get('/text', route(() => ({ text: menuAsText({ includeUnavailable: true }) })));

menuRouter.get('/categories', route(() => listCategories()));
menuRouter.post('/categories', route((req) => createCategory(z.object({ name: z.string().min(1), position: z.number().int().optional() }).parse(req.body))));
menuRouter.patch('/categories/:id', route((req) => updateCategory(req.params.id!, req.body ?? {})));

menuRouter.get('/products', route((req) => listProducts({ onlyActive: req.query.all === undefined })));
menuRouter.get('/products/:id', route((req) => getProductOrThrow(req.params.id!)));
menuRouter.post('/products', route((req) => createProduct(productBody.parse(req.body))));
menuRouter.patch('/products/:id', route((req) => updateProduct(req.params.id!, productBody.partial().parse(req.body))));
menuRouter.delete(
  '/products/:id',
  route((req) => {
    deleteProduct(req.params.id!);
    return { ok: true };
  }),
);

menuRouter.post(
  '/products/reorder',
  route((req) => {
    const { ids } = z.object({ ids: z.array(z.string()) }).parse(req.body);
    reorderProducts(ids);
    return { ok: true };
  }),
);

menuRouter.post(
  '/products/:id/modifier-groups',
  route((req) => {
    const { group_id } = z.object({ group_id: z.string() }).parse(req.body);
    attachModifierGroup(req.params.id!, group_id);
    return { ok: true };
  }),
);
