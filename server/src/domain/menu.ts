import { all, get, jsonParse, run, toDbBool, transaction } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/http.js';
import { similarity } from '../lib/text.js';
import type { Category, Modifier, ModifierGroup, Product } from './types.js';

interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  price_cents: number;
  cost_cents: number;
  active: number;
  available: number;
  available_override: number | null;
  position: number;
  prep_seconds: number;
  tags: string;
  allergens: string;
  image_url: string | null;
}

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
`;

const mapProduct = (row: ProductRow): Product => ({
  id: row.id,
  sku: row.sku,
  name: row.name,
  description: row.description,
  category_id: row.category_id,
  category_name: row.category_name,
  price_cents: row.price_cents,
  cost_cents: row.cost_cents,
  active: row.active === 1,
  available: row.available === 1,
  available_override: row.available_override === null ? null : row.available_override === 1,
  position: row.position,
  prep_seconds: row.prep_seconds,
  tags: jsonParse<string[]>(row.tags, []),
  allergens: jsonParse<string[]>(row.allergens, []),
  image_url: row.image_url,
});

// ── Categorias ──────────────────────────────────────────────────────────────

export const listCategories = (): Category[] =>
  all<{ id: string; name: string; position: number; active: number }>(
    'SELECT * FROM categories ORDER BY position, name',
  ).map((c) => ({ ...c, active: c.active === 1 }));

export function createCategory(input: { name: string; position?: number }): Category {
  const id = newId('cat');
  run('INSERT INTO categories (id, name, position) VALUES (?, ?, ?)', [
    id,
    input.name,
    input.position ?? 0,
  ]);
  return { id, name: input.name, position: input.position ?? 0, active: true };
}

export function updateCategory(id: string, patch: Partial<Category>): Category {
  const current = get<{ id: string }>('SELECT id FROM categories WHERE id = ?', [id]);
  if (!current) throw notFound('Categoria');
  run('UPDATE categories SET name = COALESCE(?, name), position = COALESCE(?, position), active = COALESCE(?, active) WHERE id = ?', [
    patch.name ?? null,
    patch.position ?? null,
    patch.active === undefined ? null : toDbBool(patch.active),
    id,
  ]);
  return listCategories().find((c) => c.id === id)!;
}

// ── Productos ───────────────────────────────────────────────────────────────

export interface ListProductsOptions {
  onlyActive?: boolean;
  onlyAvailable?: boolean;
  categoryId?: string;
}

export function listProducts(opts: ListProductsOptions = {}): Product[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.onlyActive) where.push('p.active = 1');
  if (opts.onlyAvailable) where.push('p.available = 1');
  if (opts.categoryId) {
    where.push('p.category_id = ?');
    params.push(opts.categoryId);
  }
  const sql = `${PRODUCT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.position, p.position, p.name`;
  return all<ProductRow>(sql, params).map(mapProduct);
}

export function getProduct(id: string): Product | undefined {
  const row = get<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = ?`, [id]);
  return row ? mapProduct(row) : undefined;
}

export function getProductOrThrow(id: string): Product {
  const product = getProduct(id);
  if (!product) throw notFound(`Producto ${id}`);
  return product;
}

export interface ProductInput {
  name: string;
  description?: string;
  category_id?: string | null;
  price_cents: number;
  cost_cents?: number;
  sku?: string | null;
  active?: boolean;
  available?: boolean;
  available_override?: boolean | null;
  position?: number;
  prep_seconds?: number;
  tags?: string[];
  allergens?: string[];
  image_url?: string | null;
}

export function createProduct(input: ProductInput): Product {
  const id = newId('prd');
  run(
    `INSERT INTO products
       (id, sku, name, description, category_id, price_cents, cost_cents,
        active, available, available_override, position, prep_seconds, tags, allergens, image_url)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.sku ?? null,
      input.name,
      input.description ?? '',
      input.category_id ?? null,
      input.price_cents,
      input.cost_cents ?? 0,
      toDbBool(input.active ?? true),
      toDbBool(input.available ?? true),
      input.available_override === undefined || input.available_override === null
        ? null
        : toDbBool(input.available_override),
      input.position ?? 0,
      input.prep_seconds ?? 600,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.allergens ?? []),
      input.image_url ?? null,
    ],
  );
  return getProductOrThrow(id);
}

export function updateProduct(id: string, patch: Partial<ProductInput>): Product {
  const current = getProductOrThrow(id);
  const next = { ...current, ...patch };

  // Prender o apagar la disponibilidad a mano fija un override: si no, la
  // sincronizacion automatica por stock pisaria la decision del local.
  const override =
    patch.available_override !== undefined
      ? patch.available_override
      : patch.available !== undefined
        ? patch.available
        : current.available_override;

  run(
    `UPDATE products SET
       sku = ?, name = ?, description = ?, category_id = ?, price_cents = ?, cost_cents = ?,
       active = ?, available = ?, available_override = ?, position = ?, prep_seconds = ?,
       tags = ?, allergens = ?, image_url = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [
      next.sku ?? null,
      next.name,
      next.description ?? '',
      next.category_id ?? null,
      next.price_cents,
      next.cost_cents ?? 0,
      toDbBool(next.active),
      toDbBool(next.available),
      override === null || override === undefined ? null : toDbBool(override),
      next.position ?? 0,
      next.prep_seconds ?? 600,
      JSON.stringify(next.tags ?? []),
      JSON.stringify(next.allergens ?? []),
      next.image_url ?? null,
      id,
    ],
  );
  return getProductOrThrow(id);
}

export function deleteProduct(id: string): void {
  const sold = get<{ n: number }>('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?', [id]);
  if (sold && sold.n > 0) {
    // Nunca borramos algo que ya se vendio: rompe el historico de ventas.
    updateProduct(id, { active: false, available: false });
    return;
  }
  run('DELETE FROM products WHERE id = ?', [id]);
}

/** Reordena la carta dentro de una categoria. */
export function reorderProducts(orderedIds: string[]): void {
  transaction(() => {
    orderedIds.forEach((id, index) => {
      run('UPDATE products SET position = ?, updated_at = datetime(\'now\') WHERE id = ?', [index, id]);
    });
  });
}

// ── Modificadores ───────────────────────────────────────────────────────────

interface ModifierRow extends Omit<Modifier, 'available'> {
  available: number;
}

const mapModifier = (row: ModifierRow): Modifier => ({ ...row, available: row.available === 1 });


export function listModifierGroups(): ModifierGroup[] {
  const groups = all<{ id: string; name: string; min_select: number; max_select: number; position: number }>(
    'SELECT * FROM modifier_groups ORDER BY position, name',
  );
  const mods = all<ModifierRow>('SELECT * FROM modifiers ORDER BY position, name');
  return groups.map((g) => ({
    ...g,
    modifiers: mods.filter((m) => m.group_id === g.id).map(mapModifier),
  }));
}

export function getModifiersForProduct(productId: string): ModifierGroup[] {
  const ids = all<{ group_id: string }>(
    'SELECT group_id FROM product_modifier_groups WHERE product_id = ?',
    [productId],
  ).map((r) => r.group_id);
  return listModifierGroups().filter((g) => ids.includes(g.id));
}

export function getModifiers(ids: string[]): Modifier[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return all<ModifierRow>(`SELECT * FROM modifiers WHERE id IN (${placeholders})`, ids).map(mapModifier);
}

export function attachModifierGroup(productId: string, groupId: string): void {
  run('INSERT OR IGNORE INTO product_modifier_groups (product_id, group_id) VALUES (?, ?)', [
    productId,
    groupId,
  ]);
}

// ── Busqueda para el chatbot ────────────────────────────────────────────────

export interface ProductMatch {
  product: Product;
  score: number;
}

/**
 * Busca productos por nombre, descripcion, categoria o tags.
 * Devuelve tambien los no disponibles: el bot necesita poder decir
 * "tenemos milanesa pero se nos acabo" en vez de "no existe".
 */
export function searchProducts(query: string, limit = 6): ProductMatch[] {
  const catalog = listProducts({ onlyActive: true });
  const scored = catalog.map((product) => {
    const haystacks: [string, number][] = [
      [product.name, 1],
      [product.description, 0.55],
      [product.category_name ?? '', 0.45],
      [product.tags.join(' '), 0.5],
    ];
    const score = Math.max(...haystacks.map(([text, weight]) => similarity(query, text) * weight));
    return { product, score };
  });
  return scored
    .filter((m) => m.score >= 0.3)
    .sort((a, b) => b.score - a.score || Number(b.product.available) - Number(a.product.available))
    .slice(0, limit);
}

/** Vuelca la carta a texto plano: es el contexto que recibe el modelo. */
export function menuAsText(options: { includeUnavailable?: boolean } = {}): string {
  const products = listProducts({ onlyActive: true });
  const categories = listCategories();
  const lines: string[] = [];

  const groups = new Map<string, Product[]>();
  for (const p of products) {
    if (!p.available && !options.includeUnavailable) continue;
    const key = p.category_name ?? 'Otros';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const order = [...categories.map((c) => c.name), 'Otros'];
  for (const categoryName of order) {
    const items = groups.get(categoryName);
    if (!items?.length) continue;
    lines.push(`\n## ${categoryName}`);
    for (const p of items) {
      const price = (p.price_cents / 100).toFixed(2);
      const flags = [
        !p.available ? 'SIN STOCK' : null,
        p.tags.length ? p.tags.join('/') : null,
        p.allergens.length ? `contiene: ${p.allergens.join(', ')}` : null,
      ].filter(Boolean);
      const suffix = flags.length ? ` [${flags.join(' | ')}]` : '';
      const desc = p.description ? ` — ${p.description}` : '';
      lines.push(`- (${p.id}) ${p.name}: $${price}${desc}${suffix}`);

      for (const group of getModifiersForProduct(p.id)) {
        const opts = group.modifiers
          .filter((m) => m.available)
          .map((m) => `${m.name}${m.price_cents ? ` +$${(m.price_cents / 100).toFixed(2)}` : ''} (${m.id})`)
          .join(', ');
        if (opts) lines.push(`    · ${group.name} [elegir ${group.min_select}-${group.max_select}]: ${opts}`);
      }
    }
  }
  return lines.join('\n').trim() || '(La carta esta vacia)';
}

export function assertProductOrderable(productId: string): Product {
  const product = getProduct(productId);
  if (!product) throw notFound(`Producto ${productId}`);
  if (!product.active) throw badRequest(`${product.name} no esta en la carta`);
  return product;
}
