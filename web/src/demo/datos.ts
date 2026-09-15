import bruto from '../demo-data.json';

/**
 * El local de ejemplo, tal como lo exporta `server/scripts/export-demo.ts`.
 * Son 43 kB: entra en el bundle sin que se note.
 */
export interface Producto {
  id: string;
  name: string;
  category_id: string;
  price_cents: number;
  cost_cents: number;
  available: boolean;
  active: boolean;
  description: string;
  prep_seconds: number;
  modifier_group_ids: string[];
}

export interface Insumo {
  id: string;
  name: string;
  unit: string;
  stock_qty: number;
  min_qty: number;
  par_qty: number;
  cost_cents: number;
  perishable: boolean;
}

export interface DatosDemo {
  settings: Record<string, string>;
  categories: Array<{ id: string; name: string; position: number }>;
  products: Producto[];
  ingredients: Insumo[];
  recipes: Record<string, Array<{ ingredient_id: string; qty: number }>>;
  suppliers: Array<Record<string, unknown>>;
  offers: Record<string, Array<Record<string, unknown>>>;
  knowledge: Array<Record<string, unknown>>;
  daily_usage: Record<string, number>;
  service: { orders: Array<Record<string, unknown>> };
  week: Record<string, unknown>;
  yesterday: Record<string, unknown>;
  by_day: Array<Record<string, unknown>>;
  performance: Array<Record<string, unknown>>;
  lagging: Array<Record<string, unknown>>;
  alerts_snapshot: Array<Record<string, unknown>>;
}

export const datos = bruto as unknown as DatosDemo;
