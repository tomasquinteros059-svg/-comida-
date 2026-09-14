-- =============================================================================
-- comeIA — esquema de base de datos
--
-- Convenciones:
--   * Todo el dinero se guarda en centavos (INTEGER). Nunca floats.
--   * Las fechas son texto ISO-8601 en UTC (datetime('now')).
--   * Los ids son TEXT (ulid-ish) generados en la aplicacion.
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Configuracion del local ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Carta ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  sku           TEXT UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
  cost_cents    INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  -- active: esta en la carta. available: hay para vender ahora.
  active        INTEGER NOT NULL DEFAULT 1,
  available     INTEGER NOT NULL DEFAULT 1,
  -- Decision manual del local, que gana sobre el calculo automatico por stock:
  --   NULL = automatico   0 = apagado a mano   1 = forzado disponible
  available_override INTEGER,
  position      INTEGER NOT NULL DEFAULT 0,
  prep_seconds  INTEGER NOT NULL DEFAULT 600,
  tags          TEXT NOT NULL DEFAULT '[]',   -- JSON: ["vegetariano","picante"]
  allergens     TEXT NOT NULL DEFAULT '[]',   -- JSON: ["gluten","lacteos"]
  image_url     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active, available);

-- Opciones del producto (tamanio, punto de coccion, extras...)
CREATE TABLE IF NOT EXISTS modifier_groups (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  min_select    INTEGER NOT NULL DEFAULT 0,
  max_select    INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS modifiers (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  available   INTEGER NOT NULL DEFAULT 1,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_modifier_groups (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, group_id)
);

-- ── Insumos y recetas ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingredients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  unit          TEXT NOT NULL DEFAULT 'un',      -- un | g | kg | ml | l
  stock_qty     REAL NOT NULL DEFAULT 0,
  min_qty       REAL NOT NULL DEFAULT 0,         -- punto de reposicion
  par_qty       REAL NOT NULL DEFAULT 0,         -- nivel objetivo al reponer
  cost_cents    INTEGER NOT NULL DEFAULT 0,      -- costo por unidad
  perishable    INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cuanto insumo consume un producto (o un modificador) por unidad vendida.
CREATE TABLE IF NOT EXISTS recipe_items (
  id            TEXT PRIMARY KEY,
  product_id    TEXT REFERENCES products(id) ON DELETE CASCADE,
  modifier_id   TEXT REFERENCES modifiers(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty           REAL NOT NULL CHECK (qty > 0),
  CHECK ((product_id IS NOT NULL) <> (modifier_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_recipe_product ON recipe_items(product_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id            TEXT PRIMARY KEY,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  delta         REAL NOT NULL,                  -- negativo = consumo
  reason        TEXT NOT NULL,                  -- venta | compra | ajuste | merma
  ref_type      TEXT,                           -- order | purchase_order | manual
  ref_id        TEXT,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_ing  ON stock_movements(ingredient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_date ON stock_movements(created_at);

-- ── Proveedores y reposicion express ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL DEFAULT '',
  email           TEXT NOT NULL DEFAULT '',
  -- express = entrega en el dia / inmediata
  express         INTEGER NOT NULL DEFAULT 0,
  lead_time_hours INTEGER NOT NULL DEFAULT 24,
  min_order_cents INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  note            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS supplier_products (
  id              TEXT PRIMARY KEY,
  supplier_id     TEXT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  ingredient_id   TEXT NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  price_cents     INTEGER NOT NULL,             -- precio por pack
  pack_size       REAL NOT NULL DEFAULT 1,      -- unidades de insumo por pack
  lead_time_hours INTEGER,                      -- override del proveedor
  UNIQUE (supplier_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  supplier_id    TEXT NOT NULL REFERENCES suppliers(id),
  -- borrador -> enviada -> confirmada -> recibida | cancelada
  status         TEXT NOT NULL DEFAULT 'borrador',
  urgency        TEXT NOT NULL DEFAULT 'normal', -- normal | express | inmediato
  total_cents    INTEGER NOT NULL DEFAULT 0,
  eta_at         TEXT,
  origin         TEXT NOT NULL DEFAULT 'manual', -- manual | alerta_stock | pedido_cliente
  origin_ref     TEXT,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT,
  received_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status, created_at);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id            TEXT PRIMARY KEY,
  purchase_id   TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  qty           REAL NOT NULL CHECK (qty > 0),
  unit_cents    INTEGER NOT NULL DEFAULT 0,
  received_qty  REAL NOT NULL DEFAULT 0
);

-- ── Pedidos ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,           -- identificador global: PED-7Q4K9M
  -- numero que canta el mostrador; se reinicia cada dia
  daily_number   INTEGER NOT NULL DEFAULT 0,
  channel        TEXT NOT NULL DEFAULT 'chat',   -- chat | mostrador | telefono | web
  -- borrador -> confirmado -> en_preparacion -> listo -> entregado | cancelado
  status         TEXT NOT NULL DEFAULT 'borrador',
  service_type   TEXT NOT NULL DEFAULT 'local',  -- local | takeaway | delivery
  table_label    TEXT,
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at   TEXT,
  ready_at       TEXT,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_date   ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       TEXT NOT NULL REFERENCES products(id),
  product_name     TEXT NOT NULL,               -- snapshot: la carta cambia
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL,
  unit_cost_cents  INTEGER NOT NULL DEFAULT 0,
  modifiers        TEXT NOT NULL DEFAULT '[]',  -- JSON [{id,name,price_cents}]
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

CREATE TABLE IF NOT EXISTS order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'sistema',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id, created_at);

-- ── Chatbot ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL DEFAULT 'web',
  customer_name TEXT NOT NULL DEFAULT '',
  -- carrito vivo de la conversacion, antes de confirmar el pedido
  cart          TEXT NOT NULL DEFAULT '[]',      -- JSON [{product_id,qty,modifiers,note}]
  service_type  TEXT NOT NULL DEFAULT 'local',
  -- datos de entrega recolectados durante la charla (mesa, direccion, telefono)
  details       TEXT NOT NULL DEFAULT '{}',
  order_id      TEXT REFERENCES orders(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,                -- user | assistant
  content         TEXT NOT NULL,
  tool_trace      TEXT NOT NULL DEFAULT '[]',   -- JSON, para depurar el bot
  rating          INTEGER,                      -- 1 / -1, feedback del local
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- Base de conocimiento con la que el local "retroalimenta" al bot:
-- horarios, politicas de envio, promos, respuestas a preguntas frecuentes.
CREATE TABLE IF NOT EXISTS knowledge (
  id         TEXT PRIMARY KEY,
  topic      TEXT NOT NULL,
  content    TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cosas que el cliente pidio y no pudimos vender. Alimenta la reposicion
-- express y las decisiones sobre la carta.
CREATE TABLE IF NOT EXISTS demand_signals (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                -- sin_stock | no_esta_en_carta
  query           TEXT NOT NULL,                -- lo que pidio el cliente
  product_id      TEXT REFERENCES products(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  resolved        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_date ON demand_signals(created_at);

-- ── Usuarios, sesiones y registro de cambios ────────────────────────────────
--
-- Tres roles, pensados por lo que cada uno necesita ver:
--   dueño      todo, incluido quien entra y las ventas
--   encargado  la operacion: carta, stock, compras, cocina y el bot
--   cocina     solo el tablero de comandas; no ve precios ni facturacion
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,      -- siempre en minuscula
  password_hash TEXT NOT NULL,             -- scrypt: salt$hash
  role          TEXT NOT NULL,             -- dueño | encargado | cocina
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- La sesion se guarda hasheada: si alguien se lleva la base, no se lleva las
-- sesiones abiertas.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- Quien cambio que. Guarda el nombre ademas del id: si el usuario se borra, el
-- registro tiene que seguir diciendo quien fue.
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  user_name  TEXT NOT NULL DEFAULT 'sistema',
  role       TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);

-- ── WhatsApp ────────────────────────────────────────────────────────────────
-- El numero del cliente, para que la misma persona siga su conversacion en vez
-- de empezar una nueva con cada mensaje.
ALTER TABLE conversations ADD COLUMN external_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_external ON conversations(external_id);

-- Meta reintenta los webhooks cuando no contesta rapido. Sin esto, un reintento
-- vuelve a procesar el mismo mensaje y el local cocina dos veces lo mismo.
CREATE TABLE IF NOT EXISTS mensajes_vistos (
  id         TEXT PRIMARY KEY,
  canal      TEXT NOT NULL DEFAULT 'whatsapp',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vistos_fecha ON mensajes_vistos(created_at);
