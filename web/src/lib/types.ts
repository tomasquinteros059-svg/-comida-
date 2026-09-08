export interface Category { id: string; name: string; position: number; active: boolean }

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
  available_override: boolean | null;
  position: number;
  prep_seconds: number;
  tags: string[];
  allergens: string[];
  image_url: string | null;
}

export interface OrderItem {
  id: string;
  product_id: string;
  product_name: string;
  qty: number;
  unit_price_cents: number;
  modifiers: { id: string; name: string; price_cents: number }[];
  note: string;
}

export interface Order {
  id: string;
  code: string;
  daily_number: number;
  channel: string;
  status: string;
  service_type: string;
  table_label: string | null;
  customer_name: string;
  address: string;
  note: string;
  total_cents: number;
  created_at: string;
  prep_seconds?: number;
  items: OrderItem[];
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
}

export interface StockAlert {
  ingredient: Ingredient;
  level: 'agotado' | 'critico' | 'bajo';
  daily_usage: number;
  days_left: number | null;
  suggested_qty: number;
  blocks_products: string[];
}

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
  classification: 'estrella' | 'vaca' | 'enigma' | 'perro';
  days_since_last_sale: number | null;
  recommendation: string;
}

export interface LaggingProduct extends MenuItemPerformance { reason: string }

export interface DemandGap {
  query: string;
  kind: string;
  count: number;
  last_seen: string;
  product_id: string | null;
}

export interface Dashboard {
  today: SalesSummary;
  yesterday: SalesSummary;
  week: SalesSummary;
  revenue_change_pct: number | null;
  kitchen: number;
  open_orders: number;
  stock_alerts: StockAlert[];
  stock_alert_counts: { agotado: number; critico: number; bajo: number };
  lagging: LaggingProduct[];
  demand_gaps: DemandGap[];
  currency: string;
}

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

export interface PurchaseOrder {
  id: string;
  code: string;
  supplier_id: string;
  supplier_name: string;
  supplier_phone: string;
  status: string;
  urgency: string;
  total_cents: number;
  eta_at: string | null;
  origin: string;
  note: string;
  created_at: string;
  items: {
    id: string;
    ingredient_id: string;
    ingredient_name: string;
    unit: string;
    qty: number;
    unit_cents: number;
    received_qty: number;
  }[];
}

export interface ReplenishmentPlan {
  urgency: string;
  purchase_orders: PurchaseOrder[];
  unsourced: { ingredient_id: string; ingredient_name: string; qty: number }[];
  delayed: {
    ingredient_id: string;
    ingredient_name: string;
    supplier_name: string;
    lead_time_hours: number;
    deadline_hours: number;
  }[];
}

export interface ChatTurn {
  conversation_id: string;
  reply: string;
  message_id: string;
  engine: 'llm' | 'deterministico';
  trace: { tool: string; input: unknown; output: unknown }[];
  cart_size: number;
  order_id: string | null;
}

export interface KnowledgeEntry {
  id: string;
  topic: string;
  content: string;
  priority: number;
  active: boolean;
  updated_at: string;
}
