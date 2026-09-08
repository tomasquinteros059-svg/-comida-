export type OrderStatus =
  | 'borrador'
  | 'confirmado'
  | 'en_preparacion'
  | 'listo'
  | 'entregado'
  | 'cancelado';

export type ServiceType = 'local' | 'takeaway' | 'delivery';
export type Urgency = 'normal' | 'express' | 'inmediato';
export type PurchaseStatus = 'borrador' | 'enviada' | 'confirmada' | 'recibida' | 'cancelada';

export interface Modifier {
  id: string;
  group_id: string;
  name: string;
  price_cents: number;
  available: boolean;
  position: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  position: number;
  modifiers: Modifier[];
}

export interface Product {
  id: string;
  sku: string | null;
  name: string;
  description: string;
  category_id: string | null;
  category_name: string | null;
  price_cents: number;
  cost_cents: number;
  active: boolean;
  available: boolean;
  /** null = la disponibilidad la maneja el stock; true/false = decision del local. */
  available_override: boolean | null;
  position: number;
  prep_seconds: number;
  tags: string[];
  allergens: string[];
  image_url: string | null;
  modifier_groups?: ModifierGroup[];
}

export interface Category {
  id: string;
  name: string;
  position: number;
  active: boolean;
}

export interface CartLine {
  product_id: string;
  qty: number;
  modifier_ids: string[];
  note: string;
}

/** Linea del carrito ya valorizada contra la carta vigente. */
export interface PricedLine extends CartLine {
  product_name: string;
  unit_price_cents: number;
  unit_cost_cents: number;
  modifiers: { id: string; name: string; price_cents: number }[];
  line_total_cents: number;
  available: boolean;
}

export interface Ingredient {
  id: string;
  name: string;
  unit: string;
  stock_qty: number;
  min_qty: number;
  par_qty: number;
  cost_cents: number;
  perishable: boolean;
  updated_at: string;
}
