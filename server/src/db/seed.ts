/**
 * Carga un local de ejemplo completo: carta, insumos, recetas, proveedores y
 * un mes de ventas simuladas, para que los reportes y las alertas tengan datos
 * reales desde el primer arranque.
 *
 *   npm run seed             -> carga si la base esta vacia
 *   npm run seed -- --reset  -> borra todo y vuelve a cargar
 */
import { db, run, setSetting, transaction, get } from './index.js';
import { newId, shortCode } from '../lib/ids.js';
import { syncProductAvailability } from '../domain/stock.js';

const TABLES = [
  'order_events', 'order_items', 'orders', 'messages', 'conversations',
  'demand_signals', 'stock_movements', 'purchase_order_items', 'purchase_orders',
  'supplier_products', 'suppliers', 'recipe_items', 'product_modifier_groups',
  'modifiers', 'modifier_groups', 'products', 'categories', 'ingredients',
  'knowledge', 'settings',
];

function reset() {
  transaction(() => {
    for (const table of TABLES) run(`DELETE FROM ${table}`);
  });
}

const price = (pesos: number) => Math.round(pesos * 100);

export function seed({ force = false } = {}): void {
  db();
  const existing = get<{ n: number }>('SELECT COUNT(*) AS n FROM products')!;
  if (existing.n > 0 && !force) {
    console.log('La base ya tiene datos. Usa --reset para recargarla.');
    return;
  }
  if (force) reset();

  transaction(() => {
    setSetting('nombre_local', 'Rotiseria La Esquina');
    setSetting('direccion', 'Av. Rivadavia 4820');
    setSetting('telefono', '11 5555-4820');
    setSetting('horario', 'Martes a domingo de 11:00 a 15:30 y de 19:00 a 23:30');
    setSetting('demora_delivery_min', '45');

    // ── Insumos ──────────────────────────────────────────────────────────────
    const ingredients: Record<string, string> = {};
    const addIngredient = (
      key: string,
      name: string,
      unit: string,
      stock: number,
      min: number,
      par: number,
      costPesos: number,
      perishable = 0,
    ) => {
      const id = newId('ing');
      run(
        `INSERT INTO ingredients (id, name, unit, stock_qty, min_qty, par_qty, cost_cents, perishable)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, name, unit, stock, min, par, price(costPesos), perishable],
      );
      ingredients[key] = id;
    };

    addIngredient('carne', 'Carne picada', 'kg', 8, 6, 25, 7200, 1);
    addIngredient('nalga', 'Nalga para milanesa', 'kg', 4, 5, 20, 9800, 1);
    addIngredient('pollo', 'Pechuga de pollo', 'kg', 12, 5, 20, 6400, 1);
    addIngredient('mozzarella', 'Mozzarella', 'kg', 3, 4, 15, 8900, 1);
    addIngredient('harina', 'Harina 000', 'kg', 25, 10, 40, 1200);
    addIngredient('tapas_emp', 'Tapas de empanada', 'un', 60, 200, 600, 90);
    addIngredient('pan_hamb', 'Pan de hamburguesa', 'un', 34, 40, 150, 480);
    addIngredient('papas', 'Papas congeladas', 'kg', 18, 8, 30, 3100);
    addIngredient('tomate', 'Tomate', 'kg', 6, 4, 15, 2200, 1);
    addIngredient('lechuga', 'Lechuga', 'un', 5, 6, 20, 1400, 1);
    addIngredient('cebolla', 'Cebolla', 'kg', 9, 4, 15, 1600);
    addIngredient('huevo', 'Huevos', 'un', 90, 60, 240, 190);
    addIngredient('salsa', 'Salsa de tomate', 'l', 7, 5, 20, 2400);
    addIngredient('gaseosa_l', 'Gaseosa linea 1.5 L', 'un', 22, 12, 48, 1900);
    addIngredient('agua', 'Agua mineral 500 ml', 'un', 30, 12, 48, 900);
    addIngredient('cerveza', 'Cerveza 473 ml', 'un', 8, 12, 48, 1700);
    addIngredient('helado', 'Helado 1 kg', 'kg', 2, 2, 8, 8500, 1);
    addIngredient('dulce_leche', 'Dulce de leche', 'kg', 3, 2, 8, 5200);
    addIngredient('queso_crema', 'Queso crema', 'kg', 2, 2, 6, 6100, 1);

    // ── Categorias ───────────────────────────────────────────────────────────
    const categories: Record<string, string> = {};
    ['Empanadas', 'Milanesas', 'Pizzas', 'Hamburguesas', 'Guarniciones', 'Bebidas', 'Postres']
      .forEach((name, index) => {
        const id = newId('cat');
        run('INSERT INTO categories (id, name, position) VALUES (?,?,?)', [id, name, index]);
        categories[name] = id;
      });

    // ── Opciones ─────────────────────────────────────────────────────────────
    const groupPunto = newId('mg');
    run('INSERT INTO modifier_groups (id, name, min_select, max_select, position) VALUES (?,?,?,?,?)', [
      groupPunto, 'Punto de coccion', 1, 1, 0,
    ]);
    const puntos = ['Jugosa', 'A punto', 'Bien cocida'].map((name, i) => {
      const id = newId('mod');
      run('INSERT INTO modifiers (id, group_id, name, price_cents, position) VALUES (?,?,?,?,?)', [
        id, groupPunto, name, 0, i,
      ]);
      return id;
    });

    const groupExtras = newId('mg');
    run('INSERT INTO modifier_groups (id, name, min_select, max_select, position) VALUES (?,?,?,?,?)', [
      groupExtras, 'Extras', 0, 3, 1,
    ]);
    const extraQueso = newId('mod');
    run('INSERT INTO modifiers (id, group_id, name, price_cents, position) VALUES (?,?,?,?,?)', [
      extraQueso, groupExtras, 'Extra queso', price(1200), 0,
    ]);
    const extraHuevo = newId('mod');
    run('INSERT INTO modifiers (id, group_id, name, price_cents, position) VALUES (?,?,?,?,?)', [
      extraHuevo, groupExtras, 'Huevo frito', price(900), 1,
    ]);
    run('INSERT INTO recipe_items (id, modifier_id, ingredient_id, qty) VALUES (?,?,?,?)', [
      newId('rcp'), extraQueso, ingredients.mozzarella, 0.05,
    ]);
    run('INSERT INTO recipe_items (id, modifier_id, ingredient_id, qty) VALUES (?,?,?,?)', [
      newId('rcp'), extraHuevo, ingredients.huevo, 1,
    ]);

    // ── Productos ────────────────────────────────────────────────────────────
    interface Seeded {
      key: string;
      name: string;
      category: string;
      pesos: number;
      costPesos: number;
      desc: string;
      tags?: string[];
      allergens?: string[];
      prep?: number;
      recipe?: [string, number][];
      groups?: string[];
    }

    const catalog: Seeded[] = [
      { key: 'emp_carne', name: 'Empanada de carne', category: 'Empanadas', pesos: 1500, costPesos: 520,
        desc: 'Carne cortada a cuchillo, cebolla y huevo', prep: 300,
        recipe: [['tapas_emp', 1], ['carne', 0.06], ['cebolla', 0.03], ['huevo', 0.15]] },
      { key: 'emp_pollo', name: 'Empanada de pollo', category: 'Empanadas', pesos: 1500, costPesos: 480,
        desc: 'Pollo desmenuzado con morron', prep: 300,
        recipe: [['tapas_emp', 1], ['pollo', 0.06], ['cebolla', 0.02]] },
      { key: 'emp_jyq', name: 'Empanada de jamon y queso', category: 'Empanadas', pesos: 1450, costPesos: 500,
        desc: 'Clasica, bien gratinada', prep: 300, allergens: ['gluten', 'lacteos'],
        recipe: [['tapas_emp', 1], ['mozzarella', 0.05]] },
      { key: 'emp_hum', name: 'Empanada de humita', category: 'Empanadas', pesos: 1450, costPesos: 430,
        desc: 'Choclo cremoso, receta de la casa', prep: 300, tags: ['vegetariano'],
        recipe: [['tapas_emp', 1], ['queso_crema', 0.04]] },

      { key: 'mila_napo', name: 'Milanesa napolitana con papas', category: 'Milanesas', pesos: 12500, costPesos: 5200,
        desc: 'Nalga, salsa, mozzarella y papas fritas', prep: 900, allergens: ['gluten', 'lacteos'],
        recipe: [['nalga', 0.28], ['huevo', 1], ['harina', 0.05], ['salsa', 0.08], ['mozzarella', 0.08], ['papas', 0.25]],
        groups: [groupExtras] },
      { key: 'mila_pollo', name: 'Milanesa de pollo con pure', category: 'Milanesas', pesos: 11200, costPesos: 4300,
        desc: 'Suprema empanada con pure de papas', prep: 900, allergens: ['gluten'],
        recipe: [['pollo', 0.26], ['huevo', 1], ['harina', 0.05], ['papas', 0.3]] },
      { key: 'mila_sola', name: 'Milanesa a caballo', category: 'Milanesas', pesos: 13200, costPesos: 5600,
        desc: 'Milanesa de nalga con dos huevos fritos', prep: 900, allergens: ['gluten'],
        recipe: [['nalga', 0.28], ['huevo', 3], ['harina', 0.05], ['papas', 0.25]] },

      { key: 'pizza_muzza', name: 'Pizza muzzarella', category: 'Pizzas', pesos: 11000, costPesos: 3600,
        desc: 'Ocho porciones, masa de la casa', prep: 1200, tags: ['vegetariano'], allergens: ['gluten', 'lacteos'],
        recipe: [['harina', 0.35], ['mozzarella', 0.3], ['salsa', 0.15]],
        groups: [groupExtras] },
      { key: 'pizza_napo', name: 'Pizza napolitana', category: 'Pizzas', pesos: 12500, costPesos: 4200,
        desc: 'Muzzarella, tomate en rodajas y ajo', prep: 1200, tags: ['vegetariano'], allergens: ['gluten', 'lacteos'],
        recipe: [['harina', 0.35], ['mozzarella', 0.3], ['salsa', 0.15], ['tomate', 0.2]] },
      { key: 'pizza_fugaz', name: 'Fugazzeta rellena', category: 'Pizzas', pesos: 15800, costPesos: 5900,
        desc: 'Rellena de mozzarella con cebolla arriba', prep: 1500, tags: ['vegetariano'], allergens: ['gluten', 'lacteos'],
        recipe: [['harina', 0.5], ['mozzarella', 0.45], ['cebolla', 0.3]] },

      { key: 'burger_clasica', name: 'Hamburguesa clasica', category: 'Hamburguesas', pesos: 9800, costPesos: 3400,
        desc: 'Medallon de 160 g, lechuga, tomate y cheddar', prep: 600, allergens: ['gluten', 'lacteos'],
        recipe: [['carne', 0.16], ['pan_hamb', 1], ['lechuga', 0.1], ['tomate', 0.06], ['mozzarella', 0.04]],
        groups: [groupPunto, groupExtras] },
      { key: 'burger_doble', name: 'Doble cheddar', category: 'Hamburguesas', pesos: 13400, costPesos: 5100,
        desc: 'Dos medallones, doble cheddar y salsa de la casa', prep: 700, allergens: ['gluten', 'lacteos'],
        recipe: [['carne', 0.32], ['pan_hamb', 1], ['mozzarella', 0.08]],
        groups: [groupPunto, groupExtras] },
      { key: 'burger_veggie', name: 'Hamburguesa veggie', category: 'Hamburguesas', pesos: 9600, costPesos: 3200,
        desc: 'Medallon de lentejas y quinoa', prep: 600, tags: ['vegetariano'], allergens: ['gluten'],
        recipe: [['pan_hamb', 1], ['lechuga', 0.12], ['tomate', 0.08]] },

      { key: 'papas', name: 'Papas fritas', category: 'Guarniciones', pesos: 5600, costPesos: 1400,
        desc: 'Porcion grande', prep: 420, tags: ['vegetariano'],
        recipe: [['papas', 0.35]] },
      { key: 'papas_cheddar', name: 'Papas cheddar y verdeo', category: 'Guarniciones', pesos: 8200, costPesos: 2600,
        desc: 'Con cheddar fundido', prep: 480, allergens: ['lacteos'],
        recipe: [['papas', 0.35], ['mozzarella', 0.1]] },
      { key: 'ensalada', name: 'Ensalada mixta', category: 'Guarniciones', pesos: 4800, costPesos: 1200,
        desc: 'Lechuga, tomate y cebolla', prep: 240, tags: ['vegetariano', 'sin_tacc'],
        recipe: [['lechuga', 0.3], ['tomate', 0.15], ['cebolla', 0.05]] },

      { key: 'gaseosa', name: 'Gaseosa 1.5 L', category: 'Bebidas', pesos: 3600, costPesos: 1900,
        desc: 'Linea Coca-Cola', prep: 30, recipe: [['gaseosa_l', 1]] },
      { key: 'agua', name: 'Agua mineral 500 ml', category: 'Bebidas', pesos: 1900, costPesos: 900,
        desc: 'Con o sin gas', prep: 30, recipe: [['agua', 1]] },
      { key: 'cerveza', name: 'Cerveza artesanal 473 ml', category: 'Bebidas', pesos: 4700, costPesos: 1700,
        desc: 'Rubia o roja', prep: 30, recipe: [['cerveza', 1]] },

      { key: 'flan', name: 'Flan con dulce de leche', category: 'Postres', pesos: 4200, costPesos: 1500,
        desc: 'Casero, con crema opcional', prep: 120, allergens: ['huevo', 'lacteos'],
        recipe: [['huevo', 2], ['dulce_leche', 0.06]] },
      { key: 'helado', name: 'Helado dos bochas', category: 'Postres', pesos: 3900, costPesos: 1700,
        desc: 'Consultar sabores del dia', prep: 90, allergens: ['lacteos'],
        recipe: [['helado', 0.18]] },
    ];

    const products: Record<string, string> = {};
    catalog.forEach((item, index) => {
      const id = newId('prd');
      run(
        `INSERT INTO products (id, name, description, category_id, price_cents, cost_cents,
           position, prep_seconds, tags, allergens)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id, item.name, item.desc, categories[item.category], price(item.pesos), price(item.costPesos),
          index, item.prep ?? 600, JSON.stringify(item.tags ?? []), JSON.stringify(item.allergens ?? []),
        ],
      );
      products[item.key] = id;
      for (const [ingredientKey, qty] of item.recipe ?? []) {
        run('INSERT INTO recipe_items (id, product_id, ingredient_id, qty) VALUES (?,?,?,?)', [
          newId('rcp'), id, ingredients[ingredientKey], qty,
        ]);
      }
      for (const groupId of item.groups ?? []) {
        run('INSERT INTO product_modifier_groups (product_id, group_id) VALUES (?,?)', [id, groupId]);
      }
    });

    // ── Proveedores ──────────────────────────────────────────────────────────
    const suppliers: Record<string, string> = {};
    const addSupplier = (
      key: string, name: string, phone: string, express: number, lead: number, minOrder: number, note: string,
    ) => {
      const id = newId('sup');
      run(
        `INSERT INTO suppliers (id, name, phone, email, express, lead_time_hours, min_order_cents, note)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, name, phone, '', express, lead, price(minOrder), note],
      );
      suppliers[key] = id;
    };

    addSupplier('mayorista', 'Distribuidora Central', '11 4444-1000', 0, 48, 50000, 'Mejor precio, entrega dia por medio');
    addSupplier('express', 'YaLlega Express', '11 4444-2000', 1, 3, 15000, 'Moto propia, entrega en 2-4 h');
    addSupplier('carniceria', 'Carniceria San Justo', '11 4444-3000', 1, 12, 20000, 'Carne fresca, reparto a la manana');
    addSupplier('verduleria', 'Verduleria El Puente', '11 4444-4000', 1, 6, 8000, 'Verdura del dia');

    const addPrice = (supplierKey: string, ingredientKey: string, pesos: number, pack: number, lead?: number) => {
      run(
        `INSERT INTO supplier_products (id, supplier_id, ingredient_id, price_cents, pack_size, lead_time_hours)
         VALUES (?,?,?,?,?,?)`,
        [newId('spp'), suppliers[supplierKey], ingredients[ingredientKey], price(pesos), pack, lead ?? null],
      );
    };

    addPrice('mayorista', 'tapas_emp', 8500, 100);
    addPrice('express', 'tapas_emp', 11000, 100);
    addPrice('mayorista', 'mozzarella', 82000, 10);
    addPrice('express', 'mozzarella', 95000, 10);
    addPrice('carniceria', 'carne', 70000, 10);
    addPrice('carniceria', 'nalga', 96000, 10);
    addPrice('carniceria', 'pollo', 62000, 10);
    addPrice('mayorista', 'harina', 11000, 10);
    addPrice('mayorista', 'papas', 29000, 10);
    addPrice('mayorista', 'pan_hamb', 4200, 12);
    addPrice('express', 'pan_hamb', 5200, 12);
    addPrice('verduleria', 'tomate', 21000, 10);
    addPrice('verduleria', 'lechuga', 13000, 10);
    addPrice('verduleria', 'cebolla', 15000, 10);
    addPrice('mayorista', 'huevo', 17000, 100);
    addPrice('mayorista', 'salsa', 22000, 12);
    addPrice('mayorista', 'gaseosa_l', 18000, 12);
    addPrice('express', 'gaseosa_l', 22000, 12);
    addPrice('mayorista', 'agua', 8500, 12);
    addPrice('mayorista', 'cerveza', 16000, 12);
    addPrice('express', 'cerveza', 19500, 12);
    addPrice('mayorista', 'helado', 81000, 10);
    addPrice('mayorista', 'dulce_leche', 50000, 10);
    addPrice('mayorista', 'queso_crema', 59000, 10);

    // ── Conocimiento del bot ─────────────────────────────────────────────────
    const knowledge: [string, string, number][] = [
      ['Horarios', 'Abrimos de martes a domingo, de 11:00 a 15:30 y de 19:00 a 23:30. Los lunes cerramos.', 10],
      ['Delivery', 'Enviamos en un radio de 3 km. El envio cuesta $1.800 y la demora estimada es de 45 minutos.', 9],
      ['Medios de pago', 'Aceptamos efectivo, transferencia, debito y credito en una cuota.', 8],
      ['Promociones', 'De martes a jueves la docena de empanadas tiene 15% de descuento.', 7],
      ['Celiacos', 'No tenemos cocina libre de gluten. La ensalada mixta es la unica opcion sin TACC.', 6],
      ['Reservas', 'Tomamos reservas para grupos de mas de 6 personas por telefono al 11 5555-4820.', 4],
    ];
    for (const [topic, content, priority] of knowledge) {
      run('INSERT INTO knowledge (id, topic, content, priority) VALUES (?,?,?,?)', [
        newId('kb'), topic, content, priority,
      ]);
    }

    // ── Historial de ventas ──────────────────────────────────────────────────
    seedSalesHistory(products, 45);
  });

  syncProductAvailability();
  console.log('Local de ejemplo cargado: carta, insumos, proveedores y 45 dias de ventas.');
}

/**
 * Genera pedidos pasados con un patron creible: picos a la noche, fines de
 * semana mas cargados y algunos productos que van perdiendo salida (para que
 * el reporte de "rezagados" tenga de que hablar).
 */
function seedSalesHistory(products: Record<string, string>, days: number): void {
  // Peso relativo de cada producto. El segundo valor es la tendencia:
  // 1 = estable, <1 = se va cayendo con el correr de los dias.
  const weights: [string, number, number][] = [
    ['emp_carne', 26, 1], ['emp_pollo', 16, 1], ['emp_jyq', 12, 1], ['emp_hum', 3, 0.25],
    ['mila_napo', 14, 1], ['mila_pollo', 8, 1], ['mila_sola', 2, 0.3],
    ['pizza_muzza', 12, 1], ['pizza_napo', 7, 1], ['pizza_fugaz', 5, 1],
    ['burger_clasica', 15, 1], ['burger_doble', 10, 1], ['burger_veggie', 2, 0.2],
    ['papas', 18, 1], ['papas_cheddar', 9, 1], ['ensalada', 2, 0.4],
    ['gaseosa', 20, 1], ['agua', 8, 1], ['cerveza', 7, 1],
    ['flan', 5, 1], ['helado', 3, 0.5],
  ];

  const priceOf = (id: string) =>
    get<{ price_cents: number; cost_cents: number; name: string }>(
      'SELECT price_cents, cost_cents, name FROM products WHERE id = ?', [id],
    )!;

  // Generador pseudoaleatorio con semilla fija: el seed es reproducible.
  let state = 987654321;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  const channels = ['chat', 'chat', 'chat', 'mostrador', 'telefono'];
  const serviceTypes = ['local', 'takeaway', 'delivery'];

  for (let dayOffset = days; dayOffset >= 1; dayOffset--) {
    const date = new Date();
    date.setDate(date.getDate() - dayOffset);
    const weekday = date.getDay();
    if (weekday === 1) continue; // lunes cerrado

    const progress = 1 - dayOffset / days; // 0 = mas viejo, 1 = hoy
    const busy = weekday === 5 || weekday === 6 || weekday === 0 ? 1.6 : 1;
    const orderCount = Math.round((8 + rand() * 6) * busy);

    for (let i = 0; i < orderCount; i++) {
      const hour = rand() < 0.35 ? 12 + Math.floor(rand() * 3) : 20 + Math.floor(rand() * 3);
      const minute = Math.floor(rand() * 60);
      date.setHours(hour, minute, Math.floor(rand() * 60), 0);
      const createdAt = date.toISOString().slice(0, 19).replace('T', ' ');

      const orderId = newId('ord');
      const lineCount = 1 + Math.floor(rand() * 3);
      let subtotal = 0;

      const picked = new Set<string>();
      const lines: { key: string; qty: number }[] = [];
      for (let l = 0; l < lineCount; l++) {
        const key = pickWeighted(weights, rand, progress);
        if (picked.has(key)) continue;
        picked.add(key);
        lines.push({ key, qty: 1 + Math.floor(rand() * (key.startsWith('emp_') ? 6 : 2)) });
      }
      if (!lines.length) continue;

      const channel = channels[Math.floor(rand() * channels.length)]!;
      const serviceType = serviceTypes[Math.floor(rand() * serviceTypes.length)]!;

      run(
        `INSERT INTO orders (id, code, daily_number, channel, status, service_type, customer_name,
           subtotal_cents, total_cents, created_at, confirmed_at, closed_at)
         VALUES (?,?,?,?,'entregado',?,?,0,0,?,?,?)`,
        [orderId, shortCode('PED'), i + 1, channel, serviceType, '', createdAt, createdAt, createdAt],
      );

      for (const line of lines) {
        const productId = products[line.key]!;
        const info = priceOf(productId);
        subtotal += info.price_cents * line.qty;
        run(
          `INSERT INTO order_items (id, order_id, product_id, product_name, qty, unit_price_cents,
             unit_cost_cents, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [newId('oit'), orderId, productId, info.name, line.qty, info.price_cents, info.cost_cents, createdAt],
        );
      }

      run('UPDATE orders SET subtotal_cents = ?, total_cents = ? WHERE id = ?', [subtotal, subtotal, orderId]);
      run('INSERT INTO order_events (id, order_id, status, actor, created_at) VALUES (?,?,?,?,?)', [
        newId('evt'), orderId, 'entregado', 'seed', createdAt,
      ]);
    }
  }
}

function pickWeighted(
  weights: [string, number, number][],
  rand: () => number,
  progress: number,
): string {
  // La tendencia hace que los productos "en caida" pesen menos cuanto mas
  // cerca de hoy estamos.
  const adjusted = weights.map(([key, weight, trend]) => {
    const factor = trend >= 1 ? 1 : 1 - progress * (1 - trend);
    return [key, weight * factor] as [string, number];
  });
  const total = adjusted.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [key, weight] of adjusted) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return adjusted[0]![0];
}

const isMain = process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js');
if (isMain) {
  seed({ force: process.argv.includes('--reset') });
}
