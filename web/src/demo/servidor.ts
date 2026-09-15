import { datos, type Insumo, type Producto } from './datos';

/**
 * comeIA entero corriendo adentro del navegador.
 *
 * La demo no habla con ningún servidor: este módulo responde las mismas rutas
 * que la API real, con los datos de una rotisería de ejemplo. Sirve para ver
 * cómo funciona desde el teléfono sin tener nada montado.
 *
 * Lo que importa es que el circuito sea el de verdad: el chat toma el pedido,
 * la comanda cae en la cocina, el stock baja POR RECETA y la alerta aparece
 * sola. Si eso no se ve, la demo no muestra el producto.
 */

const centavos = (n: number) => `$${(n / 100).toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;

const normalizar = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ── Estado ──────────────────────────────────────────────────────────────────

interface LineaDePedido {
  product_id: string;
  product_name: string;
  qty: number;
  unit_price_cents: number;
  unit_cost_cents: number;
  modifiers: Array<{ id: string; name: string; price_cents: number }>;
  note: string;
}

interface Pedido {
  id: string;
  code: string;
  daily_number: number;
  channel: string;
  status: string;
  service_type: string;
  table_label: string | null;
  customer_name: string;
  note: string;
  subtotal_cents: number;
  total_cents: number;
  payment_status: string;
  payment_method: string;
  paid_at: string | null;
  items: LineaDePedido[];
  created_at: string;
  conversation_id: string | null;
}

interface Mensaje {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

const estado = {
  productos: datos.products.map((p) => ({ ...p })) as Producto[],
  insumos: datos.ingredients.map((i) => ({ ...i })) as Insumo[],
  pedidos: [] as Pedido[],
  mensajes: [] as Mensaje[],
  carritos: new Map<string, LineaDePedido[]>(),
  siguienteNumero: 1,
  contador: 0,
};

const nuevoId = (prefijo: string) => `${prefijo}_${(++estado.contador).toString(36)}${Date.now().toString(36)}`;
const ahora = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Los pedidos del servicio en curso, para que la cocina arranque con trabajo. */
function sembrarServicio() {
  const base = Date.now();
  for (const bruto of datos.service.orders) {
    const o = bruto as Record<string, unknown>;
    const items = ((o.items as LineaDePedido[] | undefined) ?? []).map((i) => ({
      ...i,
      modifiers: i.modifiers ?? [],
      note: i.note ?? '',
      unit_cost_cents: i.unit_cost_cents ?? 0,
    }));
    const subtotal = items.reduce((s, i) => s + i.unit_price_cents * i.qty, 0);
    const minutos = Number(o.minutes_ago ?? 10);
    estado.pedidos.push({
      id: String(o.id),
      code: String(o.code),
      daily_number: Number(o.daily_number),
      channel: String(o.channel ?? 'chat'),
      status: String(o.status),
      service_type: String(o.service_type ?? 'local'),
      table_label: (o.table_label as string | null) ?? null,
      customer_name: String(o.customer_name ?? ''),
      note: String(o.note ?? ''),
      subtotal_cents: subtotal,
      total_cents: subtotal,
      payment_status: o.status === 'entregado' ? 'pagado' : 'sin_pagar',
      payment_method: o.status === 'entregado' ? 'efectivo' : '',
      paid_at: o.status === 'entregado' ? ahora() : null,
      items,
      created_at: new Date(base - minutos * 60_000).toISOString().replace('T', ' ').slice(0, 19),
      conversation_id: null,
    });
    estado.siguienteNumero = Math.max(estado.siguienteNumero, Number(o.daily_number) + 1);
  }
}
sembrarServicio();

// ── Stock ───────────────────────────────────────────────────────────────────

const insumo = (id: string) => estado.insumos.find((i) => i.id === id);

/** Cuánto de cada insumo hace falta para unas líneas. Es la receta. */
function necesidades(lineas: Array<{ product_id: string; qty: number }>) {
  const total = new Map<string, number>();
  for (const linea of lineas) {
    for (const r of datos.recipes[linea.product_id] ?? []) {
      total.set(r.ingredient_id, (total.get(r.ingredient_id) ?? 0) + r.qty * linea.qty);
    }
  }
  return total;
}

/** Descuenta del stock lo que se usó. Es lo único que mueve stock. */
function descontar(lineas: Array<{ product_id: string; qty: number }>, signo = -1) {
  for (const [id, cantidad] of necesidades(lineas)) {
    const ing = insumo(id);
    if (ing) ing.stock_qty = Math.round((ing.stock_qty + signo * cantidad) * 1000) / 1000;
  }
  recalcularDisponibles();
}

/** Lo que no se puede hacer, deja de ofrecerse. */
function recalcularDisponibles() {
  for (const p of estado.productos) {
    const receta = datos.recipes[p.id] ?? [];
    p.available = receta.every((r) => (insumo(r.ingredient_id)?.stock_qty ?? 0) >= r.qty);
  }
}
recalcularDisponibles();

/** Cuántas unidades de un producto se pueden hacer con lo que hay. */
function cuantosQuedan(productId: string): number {
  const receta = datos.recipes[productId] ?? [];
  if (!receta.length) return 99;
  return Math.floor(
    Math.min(...receta.map((r) => (insumo(r.ingredient_id)?.stock_qty ?? 0) / r.qty)),
  );
}

/**
 * Las alertas. No por el mínimo nomás: por cuántos días dura al ritmo real de
 * venta, que es la diferencia entre avisar a tiempo y avisar cuando ya no hay.
 */
function alertas() {
  const salida = [];
  for (const ing of estado.insumos) {
    const usoDiario = datos.daily_usage[ing.id] ?? 0;
    const diasQueDura = usoDiario > 0 ? Math.round((ing.stock_qty / usoDiario) * 10) / 10 : null;

    let nivel: string | null = null;
    if (ing.stock_qty <= 0) nivel = 'agotado';
    else if (diasQueDura !== null && diasQueDura < 2) nivel = 'critico';
    else if (ing.stock_qty < ing.min_qty) nivel = diasQueDura !== null && diasQueDura > 10 ? 'bajo' : 'critico';
    else if (diasQueDura !== null && diasQueDura < 5) nivel = 'critico';
    else if (diasQueDura !== null && diasQueDura < 8) nivel = 'bajo';
    if (!nivel) continue;

    const bloquea = estado.productos
      .filter((p) => (datos.recipes[p.id] ?? []).some((r) => r.ingredient_id === ing.id))
      .map((p) => p.name);

    salida.push({
      ingredient: ing,
      level: nivel,
      daily_usage: Math.round(usoDiario * 100) / 100,
      days_left: diasQueDura,
      suggested_qty: Math.max(0, Math.ceil(ing.par_qty - ing.stock_qty)),
      blocks_products: bloquea,
    });
  }
  const orden: Record<string, number> = { agotado: 0, critico: 1, bajo: 2 };
  return salida.sort(
    (a, b) => (orden[a.level]! - orden[b.level]!) || (a.days_left ?? 99) - (b.days_left ?? 99),
  );
}

// ── El chat ─────────────────────────────────────────────────────────────────

const producto = (id: string) => estado.productos.find((p) => p.id === id);

/** Busca un producto por nombre, tolerando errores de tipeo. */
function buscarProducto(texto: string): Producto | null {
  const t = normalizar(texto);
  let mejor: { p: Producto; puntos: number } | null = null;

  for (const p of estado.productos) {
    const nombre = normalizar(p.name);
    let puntos = 0;
    if (t.includes(nombre)) puntos = 100 + nombre.length;
    else {
      // Cuántas palabras del producto aparecen en lo que escribió.
      const palabras = nombre.split(' ').filter((w) => w.length > 3);
      const coinciden = palabras.filter((w) => t.includes(w) || t.includes(w.slice(0, -1)));
      if (coinciden.length) puntos = coinciden.length * 10 + coinciden.join('').length;
    }
    if (puntos && (!mejor || puntos > mejor.puntos)) mejor = { p, puntos };
  }
  return mejor?.p ?? null;
}

const PALABRAS_NUMERO: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, docena: 12,
};

function cantidadDe(texto: string): number {
  const t = normalizar(texto);
  const digito = t.match(/\b(\d{1,2})\b/);
  if (digito) return Math.min(Number(digito[1]), 30);
  for (const [palabra, n] of Object.entries(PALABRAS_NUMERO)) {
    if (new RegExp(`\\b${palabra}\\b`).test(t)) return n;
  }
  return 1;
}

const carrito = (id: string) => estado.carritos.get(id) ?? [];

function textoDelCarrito(id: string): string {
  const lineas = carrito(id);
  if (!lineas.length) return 'Todavía no agregaste nada.';
  const total = lineas.reduce((s, l) => s + l.unit_price_cents * l.qty, 0);
  return (
    lineas.map((l) => `${l.qty} × ${l.product_name} — ${centavos(l.unit_price_cents * l.qty)}`).join('\n') +
    `\n\nTotal: ${centavos(total)}`
  );
}

/** Confirma el pedido: es lo que descuenta el stock y manda la comanda. */
function confirmar(conversationId: string) {
  const lineas = carrito(conversationId);
  if (!lineas.length) return { error: 'El pedido está vacío, no hay nada que confirmar.' };

  const subtotal = lineas.reduce((s, l) => s + l.unit_price_cents * l.qty, 0);
  const pedido: Pedido = {
    id: nuevoId('ord'),
    code: `PED-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    daily_number: estado.siguienteNumero++,
    channel: 'chat',
    status: 'confirmado',
    service_type: 'local',
    table_label: null,
    customer_name: '',
    note: '',
    subtotal_cents: subtotal,
    total_cents: subtotal,
    payment_status: 'sin_pagar',
    payment_method: '',
    paid_at: null,
    items: lineas,
    created_at: ahora(),
    conversation_id: conversationId,
  };
  estado.pedidos.push(pedido);
  descontar(lineas);
  estado.carritos.set(conversationId, []);

  const demora = Math.max(...lineas.map((l) => producto(l.product_id)?.prep_seconds ?? 300));
  return { pedido, demora: Math.round(demora / 60) };
}

/**
 * El motor sin LLM: reglas y coincidencia difusa. Es el mismo que usa el
 * sistema cuando no hay clave de Anthropic, así que la demo muestra el piso y
 * no el techo: con Claude, entiende bastante más.
 */
/** Lo que el bot ejecutó en este turno. El panel lo muestra como "qué hizo". */
type Traza = Array<{ tool: string; input: unknown; output: unknown }>;

function responder(conversationId: string, mensaje: string, traza: Traza): string {
  const t = normalizar(mensaje);
  const pide = (...palabras: string[]) => palabras.some((p) => t.includes(p));

  if (pide('carta', 'menu', 'que tienen', 'que hay')) {
    traza.push({ tool: 'ver_carta', input: {}, output: `${estado.productos.filter((p) => p.available).length} productos disponibles` });
    const porCategoria = new Map<string, string[]>();
    for (const p of estado.productos.filter((x) => x.active)) {
      const cat = datos.categories.find((c) => c.id === p.category_id)?.name ?? 'Otros';
      const linea = `  • ${p.name} — ${centavos(p.price_cents)}${p.available ? '' : ' (sin stock)'}`;
      porCategoria.set(cat, [...(porCategoria.get(cat) ?? []), linea]);
    }
    return (
      'Esto es lo que tenemos hoy:\n\n' +
      [...porCategoria].map(([cat, items]) => `${cat}:\n${items.join('\n')}`).join('\n\n')
    );
  }

  if (pide('mi pedido', 'ver pedido', 'cuanto va', 'cuanto es', 'total')) {
    traza.push({ tool: 'ver_pedido', input: {}, output: carrito(conversationId) });
    return textoDelCarrito(conversationId);
  }

  if (pide('confirmo', 'confirmar', 'nada mas', 'eso es todo', 'listo dale', 'cerra el pedido')) {
    const r = confirmar(conversationId);
    traza.push({ tool: 'confirmar_pedido', input: {}, output: 'error' in r ? r : { pedido: r.pedido.code } });
    if ('error' in r) return `No pude cerrarlo: ${r.error}`;
    return `Listo, tu pedido es el número ${r.pedido.daily_number}. Total ${centavos(r.pedido.total_cents)}. Sale en unos ${r.demora} minutos.`;
  }

  if (pide('sacar', 'quitar', 'borra', 'cancelar')) {
    estado.carritos.set(conversationId, []);
    return 'Listo, vacié el pedido. ¿Arrancamos de nuevo?';
  }

  if (pide('hola', 'buenas', 'buen dia', 'buenas tardes', 'buenas noches') && t.length < 25) {
    return `¡Hola! Soy el bot de ${datos.settings.nombre_local ?? 'la rotisería'}. Contame qué querés pedir, o escribí "carta" para ver el menú.`;
  }

  // Lo demás se interpreta como un pedido.
  const encontrado = buscarProducto(mensaje);
  traza.push({
    tool: 'buscar_producto',
    input: { texto: mensaje },
    output: encontrado ? { id: encontrado.id, nombre: encontrado.name, disponible: encontrado.available } : null,
  });
  if (!encontrado) {
    return 'No me di cuenta qué querés. Escribí "carta" para ver lo que tenemos.';
  }

  if (!encontrado.available) {
    const alternativas = estado.productos
      .filter((p) => p.available && p.category_id === encontrado.category_id && p.id !== encontrado.id)
      .slice(0, 2)
      .map((p) => p.name);
    return (
      `${encontrado.name} no está disponible ahora.` +
      (alternativas.length ? ` Te puedo ofrecer ${alternativas.join(' o ')}.` : '')
    );
  }

  const cantidad = cantidadDe(mensaje);
  const disponibles = cuantosQuedan(encontrado.id);
  const yaEnCarrito = carrito(conversationId).find((l) => l.product_id === encontrado.id)?.qty ?? 0;

  if (cantidad + yaEnCarrito > disponibles) {
    return `De ${encontrado.name} me quedan ${disponibles}. ¿Te sirven?`;
  }

  const lineas = [...carrito(conversationId)];
  const existente = lineas.find((l) => l.product_id === encontrado.id);
  if (existente) existente.qty += cantidad;
  else {
    lineas.push({
      product_id: encontrado.id,
      product_name: encontrado.name,
      qty: cantidad,
      unit_price_cents: encontrado.price_cents,
      unit_cost_cents: encontrado.cost_cents,
      modifiers: [],
      note: '',
    });
  }
  estado.carritos.set(conversationId, lineas);
  traza.push({
    tool: 'agregar_al_pedido',
    input: { producto: encontrado.name, cantidad },
    output: { quedan: disponibles - cantidad - yaEnCarrito },
  });

  const total = lineas.reduce((s, l) => s + l.unit_price_cents * l.qty, 0);
  return `Agregué ${cantidad} x ${encontrado.name}. Van ${centavos(total)}. ¿Agregás algo más o lo confirmo?`;
}

// ── Estados de los pedidos ──────────────────────────────────────────────────

const SIGUIENTE: Record<string, string[]> = {
  confirmado: ['en_preparacion', 'cancelado'],
  en_preparacion: ['listo', 'cancelado'],
  listo: ['entregado', 'cancelado'],
  entregado: [],
  cancelado: [],
};

function avanzar(id: string, siguiente: string) {
  const pedido = estado.pedidos.find((p) => p.id === id);
  if (!pedido) throw new Error('No existe ese pedido');
  if (!SIGUIENTE[pedido.status]?.includes(siguiente)) {
    throw new Error(`No se puede pasar de ${pedido.status} a ${siguiente}`);
  }
  pedido.status = siguiente;
  // Cancelar devuelve los insumos: no se cocinó.
  if (siguiente === 'cancelado') descontar(pedido.items, +1);
  return pedido;
}

// ── Las respuestas ──────────────────────────────────────────────────────────

const hoy = () => new Date().toISOString().slice(0, 10);

function ventasDeHoy() {
  const delDia = estado.pedidos.filter((p) => !['cancelado', 'borrador'].includes(p.status));
  const facturado = delDia.reduce((s, p) => s + p.total_cents, 0);
  const costo = delDia.reduce(
    (s, p) => s + p.items.reduce((x, i) => x + i.unit_cost_cents * i.qty, 0),
    0,
  );
  const unidades = delDia.reduce((s, p) => s + p.items.reduce((x, i) => x + i.qty, 0), 0);

  const porProducto = new Map<string, { name: string; qty: number; revenue_cents: number }>();
  for (const p of delDia) {
    for (const i of p.items) {
      const actual = porProducto.get(i.product_id) ?? { name: i.product_name, qty: 0, revenue_cents: 0 };
      actual.qty += i.qty;
      actual.revenue_cents += i.unit_price_cents * i.qty;
      porProducto.set(i.product_id, actual);
    }
  }

  const porCanal = new Map<string, { orders: number; revenue_cents: number }>();
  for (const p of delDia) {
    const a = porCanal.get(p.channel) ?? { orders: 0, revenue_cents: 0 };
    a.orders += 1;
    a.revenue_cents += p.total_cents;
    porCanal.set(p.channel, a);
  }

  return {
    from: hoy(),
    to: hoy(),
    orders: delDia.length,
    revenue_cents: facturado,
    cost_cents: costo,
    margin_cents: facturado - costo,
    avg_ticket_cents: delDia.length ? Math.round(facturado / delDia.length) : 0,
    items_sold: unidades,
    by_channel: [...porCanal].map(([channel, v]) => ({ channel, ...v })),
    by_service_type: [{ service_type: 'local', orders: delDia.length, revenue_cents: facturado }],
    by_hour: [],
    top_products: [...porProducto]
      .map(([product_id, v]) => ({ product_id, ...v }))
      .sort((a, b) => b.revenue_cents - a.revenue_cents)
      .slice(0, 5),
  };
}

const pagina = <T>(items: T[], limite = 50, desde = 0) => ({
  items: items.slice(desde, desde + limite),
  total: items.length,
  desde,
  limite,
  hay_mas: desde + limite < items.length,
});

const conCategoria = (p: Producto) => ({
  ...p,
  category_name: datos.categories.find((c) => c.id === p.category_id)?.name ?? '',
  modifier_groups: [],
});

/** Las rutas. Son las mismas que la API real, con los datos del ejemplo. */
export async function responderDemo(metodo: string, ruta: string, cuerpo?: unknown): Promise<unknown> {
  const [camino, consulta] = ruta.split('?');
  const q = new URLSearchParams(consulta ?? '');
  const limite = Number(q.get('limite') ?? 50);
  const desde = Number(q.get('desde') ?? 0);
  const body = (cuerpo ?? {}) as Record<string, unknown>;

  // Un respiro para que se vea que algo pasó, como con un servidor de verdad.
  await new Promise((r) => setTimeout(r, 90));

  switch (`${metodo} ${camino}`) {
    // ── Sesión: en la demo se entra siempre, como dueño ──
    case 'GET /auth/me':
      return {
        autenticado: true,
        sinUsuarios: false,
        conToken: false,
        usuario: { id: 'usr_demo', name: 'Demo', role: 'dueño', viaToken: false },
        permisos: ['ventas', 'carta', 'stock', 'compras', 'cocina', 'bot', 'usuarios'],
      };
    case 'POST /auth/logout':
      return { ok: true };

    // ── Chat ──
    case 'GET /chat/engine':
      return { engine: 'deterministico', model: null };
    case 'POST /chat': {
      const conversationId = String(body.conversation_id ?? nuevoId('cnv'));
      const texto = String(body.message ?? '');
      estado.mensajes.push({
        id: nuevoId('msg'), conversation_id: conversationId, role: 'user', content: texto, created_at: ahora(),
      });
      // Los campos son los del tipo ChatTurn de lib/types.ts: si falta uno, el
      // panel se rompe con un error que no dice cual.
      const traza: Traza = [];
      const respuesta = responder(conversationId, texto, traza);
      const guardado = {
        id: nuevoId('msg'), conversation_id: conversationId, role: 'assistant' as const,
        content: respuesta, created_at: ahora(),
      };
      estado.mensajes.push(guardado);
      return {
        conversation_id: conversationId,
        reply: respuesta,
        message_id: guardado.id,
        engine: 'deterministico',
        trace: traza,
        cart_size: carrito(conversationId).reduce((s, l) => s + l.qty, 0),
        order_id: estado.pedidos.find((p) => p.conversation_id === conversationId)?.id ?? null,
      };
    }
    case 'GET /chat/conversations': {
      const ids = [...new Set(estado.mensajes.map((m) => m.conversation_id))];
      return pagina(
        ids.map((id) => {
          const suyos = estado.mensajes.filter((m) => m.conversation_id === id);
          return {
            id, channel: 'chat', customer_name: '', message_count: suyos.length,
            last_message: suyos[suyos.length - 1]?.content ?? '',
            updated_at: suyos[suyos.length - 1]?.created_at ?? ahora(),
            order_id: estado.pedidos.find((p) => p.conversation_id === id)?.id ?? null,
          };
        }),
        limite, desde,
      );
    }
    case 'GET /chat/flagged':
      return pagina([], limite, desde);

    // ── Carta ──
    case 'GET /menu/products':
      return estado.productos.filter((p) => q.get('all') === '1' || p.active).map(conCategoria);
    case 'GET /menu':
      return {
        categories: datos.categories.map((c) => ({
          ...c,
          products: estado.productos.filter((p) => p.category_id === c.id).map(conCategoria),
        })),
      };
    case 'GET /menu/text':
      return {
        text: datos.categories
          .map((c) => {
            const items = estado.productos
              .filter((p) => p.category_id === c.id)
              .map((p) => `  ${p.name} — ${centavos(p.price_cents)}${p.available ? '' : ' (sin stock)'}`);
            return `${c.name}\n${items.join('\n')}`;
          })
          .join('\n\n'),
      };

    // ── Cocina ──
    case 'GET /orders/kitchen':
      return estado.pedidos
        .filter((p) => ['confirmado', 'en_preparacion', 'listo'].includes(p.status))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((p) => ({ ...p, prep_seconds: 600 }));
    case 'GET /orders':
      return pagina(
        estado.pedidos
          .filter((p) => {
            const estados = q.get('status')?.split(',');
            return !estados || estados.includes(p.status);
          })
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
        limite, desde,
      );
    case 'GET /orders/comandera/config':
      return { host: '', puerto: 9100, automatica: false, copias: 1 };

    // ── Stock ──
    case 'GET /stock/ingredients':
      return estado.insumos;
    case 'GET /stock/alerts':
      return alertas();
    case 'POST /stock/sync-availability':
      recalcularDisponibles();
      return { disabled: [], enabled: [] };

    // ── Compras ──
    case 'GET /procurement/suppliers':
      return datos.suppliers;
    case 'GET /procurement/purchase-orders':
      return pagina([], limite, desde);

    // ── Reportes ──
    case 'GET /dashboard': {
      // Los campos son los del tipo Dashboard de lib/types.ts: si falta uno,
      // el panel se rompe con un error que no dice cual. Estan todos a
      // proposito, aunque alguno vaya vacio.
      const conteos = { agotado: 0, critico: 0, bajo: 0 };
      for (const a of alertas()) conteos[a.level as keyof typeof conteos] += 1;

      const hoyVentas = ventasDeHoy();
      const ayer = datos.yesterday as unknown as { revenue_cents: number };
      const cambio =
        ayer.revenue_cents > 0
          ? Math.round(((hoyVentas.revenue_cents - ayer.revenue_cents) / ayer.revenue_cents) * 1000) / 10
          : null;

      return {
        today: hoyVentas,
        yesterday: datos.yesterday,
        week: datos.week,
        by_day: datos.by_day,
        revenue_change_pct: cambio,
        open_orders: estado.pedidos.filter((p) => ['confirmado', 'en_preparacion'].includes(p.status)).length,
        kitchen: estado.pedidos.filter((p) => ['confirmado', 'en_preparacion', 'listo'].includes(p.status)).length,
        stock_alerts: alertas().slice(0, 6),
        stock_alert_counts: conteos,
        lagging: datos.lagging.slice(0, 5),
        demand_gaps: [],
        currency: 'ARS',
      };
    }
    case 'GET /sales':
      return ventasDeHoy();
    case 'GET /menu-performance':
      return datos.performance;
    case 'GET /lagging':
      return datos.lagging;
    case 'GET /demand-gaps':
      return [];
    case 'GET /knowledge':
      return datos.knowledge;
    case 'GET /settings':
      return { ...datos.settings, currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' };
    case 'GET /retencion':
      return { dias: 90, total: 0, con_pedido: 0, mensajes: estado.mensajes.length, la_mas_vieja: null, a_borrar: 0 };

    // ── Canales ──
    // En la demo no hay servidor al que Meta le pueda pegar, asi que la
    // tarjeta de WhatsApp muestra lo que muestra un local recien instalado.
    case 'GET /canales/whatsapp':
      return {
        activo: false,
        falta: ['la configuración de Meta (esto es una demo, no hay servidor)'],
        numero_id: '',
        version: 'v21.0',
      };
    case 'POST /canales/whatsapp/probar':
      return {
        listo: false,
        pasos: [
          {
            paso: 'Las credenciales están cargadas',
            ok: false,
            detalle: 'Esto es la demo: corre entera adentro del navegador',
            arreglo: 'WhatsApp necesita el servidor instalado y las credenciales de Meta.',
          },
        ],
      };

    // ── Caja ──
    case 'GET /cobros/estado':
      return {
        mercadopago: { activo: false, falta: ['esto es una demo'] },
        medios: ['efectivo', 'debito', 'credito', 'transferencia', 'mercadopago', 'otro'],
      };
    case 'GET /cobros/pendientes': {
      const pendientes = estado.pedidos.filter(
        (p) => p.payment_status !== 'pagado' && !['cancelado', 'borrador'].includes(p.status),
      );
      return { pedidos: pendientes, total_cents: pendientes.reduce((s, p) => s + p.total_cents, 0) };
    }
    case 'GET /cobros/caja': {
      const pagados = estado.pedidos.filter((p) => p.payment_status === 'pagado');
      const porMedio = new Map<string, { pedidos: number; total_cents: number }>();
      for (const p of pagados) {
        const a = porMedio.get(p.payment_method) ?? { pedidos: 0, total_cents: 0 };
        a.pedidos += 1;
        a.total_cents += p.total_cents;
        porMedio.set(p.payment_method, a);
      }
      const pendientes = estado.pedidos.filter(
        (p) => p.payment_status !== 'pagado' && !['cancelado', 'borrador'].includes(p.status),
      );
      return {
        fecha: hoy(),
        por_medio: [...porMedio].map(([payment_method, v]) => ({ payment_method, ...v })),
        cobrado_cents: pagados.reduce((s, p) => s + p.total_cents, 0),
        sin_cobrar_cents: pendientes.reduce((s, p) => s + p.total_cents, 0),
        sin_cobrar: pendientes.length,
      };
    }

    // ── Usuarios y locales ──
    case 'GET /usuarios':
      return {
        usuarios: [{
          id: 'usr_demo', name: 'Demo', username: 'demo', role: 'dueño',
          active: true, created_at: ahora(), last_login_at: ahora(),
        }],
        roles: [
          { rol: 'dueño', permisos: ['ventas', 'carta', 'stock', 'compras', 'cocina', 'bot', 'usuarios'] },
          { rol: 'encargado', permisos: ['ventas', 'carta', 'stock', 'compras', 'cocina', 'bot'] },
          { rol: 'cocina', permisos: ['cocina'] },
        ],
        permisos: ['ventas', 'carta', 'stock', 'compras', 'cocina', 'bot', 'usuarios'],
        duenios_activos: 1,
      };
    case 'GET /usuarios/auditoria':
      return { ...pagina([], limite, desde), quienes: [] };
    case 'GET /locales':
      return { locales: [{ slug: 'principal', nombre: datos.settings.nombre_local ?? 'Principal', hosts: [], activo: true, creado: ahora(), archivo: 'demo' }], actual: 'principal', varios: false };
  }

  // ── Rutas con id adentro ──
  const estadoDePedido = camino?.match(/^\/orders\/([^/]+)\/status$/);
  if (estadoDePedido && metodo === 'POST') return avanzar(estadoDePedido[1]!, String(body.status));

  const cobrar = camino?.match(/^\/cobros\/pedido\/([^/]+)\/pagado$/);
  if (cobrar && metodo === 'POST') {
    const pedido = estado.pedidos.find((p) => p.id === cobrar[1]);
    if (pedido) {
      pedido.payment_status = 'pagado';
      pedido.payment_method = String(body.medio ?? 'efectivo');
      pedido.paid_at = ahora();
    }
    return { ok: true };
  }

  const descobrar = camino?.match(/^\/cobros\/pedido\/([^/]+)\/sin-pagar$/);
  if (descobrar && metodo === 'POST') {
    const pedido = estado.pedidos.find((p) => p.id === descobrar[1]);
    if (pedido) {
      pedido.payment_status = 'sin_pagar';
      pedido.payment_method = '';
      pedido.paid_at = null;
    }
    return { ok: true };
  }

  if (camino?.startsWith('/cobros/pedido/')) return [];

  const conversacion = camino?.match(/^\/chat\/conversations\/(.+)$/);
  if (conversacion && metodo === 'GET') {
    const id = conversacion[1]!;
    return {
      conversation: { id, channel: 'chat', customer_name: '', cart: carrito(id), order_id: null },
      messages: estado.mensajes.filter((m) => m.conversation_id === id),
      cart: { lines: carrito(id), subtotal_cents: carrito(id).reduce((s, l) => s + l.unit_price_cents * l.qty, 0) },
    };
  }

  // Lo que la demo no simula, lo dice en vez de romperse en silencio.
  throw Object.assign(new Error('Esto no está en la demo. En el sistema real sí funciona.'), { status: 501 });
}

/** El stock del insumo que más rápido se está acabando, para el cartel. */
export const estadoDemo = () => ({
  pedidosEnCocina: estado.pedidos.filter((p) => ['confirmado', 'en_preparacion', 'listo'].includes(p.status)).length,
  alertas: alertas().length,
});
