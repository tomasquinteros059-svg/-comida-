import { get } from '../db/index.js';

/**
 * Traduce un pedido HTTP a una frase que se entienda.
 *
 * El registro lo lee el dueño del local, no alguien que sepa leer rutas: una
 * fila que dice "POST /api/stock/ingredients/ing_01M2G7.../movements" no le
 * sirve para nada. Tiene que decir "ajustó el stock · Mozzarella".
 */

interface Descripcion {
  action: string;
  target: string;
}

/** Rutas con nombre propio: lo que hacen no se deduce del metodo. */
const EXACTAS: Record<string, string> = {
  'POST /stock/sync-availability': 'recalculó qué se puede hacer',
  'POST /procurement/replenish': 'pidió reposición de stock',
  'POST /ingest/preview': 'revisó una planilla antes de importarla',
  'POST /ingest/apply': 'importó una planilla',
  'PUT /settings': 'cambió los datos del local',
  'POST /orders': 'cargó un pedido a mano',
};

/**
 * Recursos, en el orden en que se prueban: el primero que coincide gana, asi
 * que los caminos mas largos van antes que los mas cortos.
 */
const RECURSOS: Array<{ prefijo: string; singular: string; tabla?: string }> = [
  { prefijo: '/stock/ingredients', singular: 'un insumo', tabla: 'ingredients' },
  { prefijo: '/menu/categories', singular: 'una categoría', tabla: 'categories' },
  { prefijo: '/menu/products', singular: 'un producto', tabla: 'products' },
  { prefijo: '/menu/modifier-groups', singular: 'un grupo de opciones' },
  { prefijo: '/menu/modifiers', singular: 'una opción' },
  { prefijo: '/menu/recipes', singular: 'una receta' },
  { prefijo: '/procurement/suppliers', singular: 'un proveedor', tabla: 'suppliers' },
  { prefijo: '/procurement/purchase-order-items', singular: 'una línea de compra' },
  { prefijo: '/procurement/purchase-orders', singular: 'una orden de compra' },
  { prefijo: '/procurement/prices', singular: 'un precio de proveedor' },
  { prefijo: '/orders', singular: 'un pedido', tabla: 'orders' },
  { prefijo: '/knowledge', singular: 'una nota del bot', tabla: 'knowledge' },
  { prefijo: '/chat', singular: 'una conversación' },
];

const VERBOS: Record<string, string> = {
  POST: 'dio de alta',
  PATCH: 'editó',
  PUT: 'guardó',
  DELETE: 'borró',
};

/** Acciones sobre un recurso ya existente, que no son un alta. */
const SUFIJOS: Record<string, string> = {
  movements: 'ajustó el stock de',
  status: 'cambió el estado de',
  receive: 'registró la llegada de',
  cancel: 'canceló',
  rate: 'calificó',
};

export function describirPedido(metodo: string, ruta: string, cuerpo?: unknown): Descripcion {
  const clave = `${metodo} ${ruta}`;
  const exacta = EXACTAS[clave];
  if (exacta) return { action: exacta, target: '' };

  const recurso = RECURSOS.find((r) => ruta.startsWith(r.prefijo));
  if (!recurso) return { action: `${metodo} ${ruta}`, target: '' };

  // Lo que queda despues del prefijo: "", "/ing_01M2G7", "/ord_9/status"...
  const resto = ruta.slice(recurso.prefijo.length).split('/').filter(Boolean);
  const id = resto[0] ?? '';
  const sufijo = resto[1] ?? '';
  // En un alta todavia no hay id en la ruta: el nombre viene en el cuerpo, y
  // sin el la fila diria "dio de alta un producto" sin decir cual.
  const nombre = id ? (recurso.tabla ? nombreDe(recurso.tabla, id) : '') : nombreDelCuerpo(cuerpo);
  const target = nombre || id;

  const verboSufijo = SUFIJOS[sufijo];
  if (verboSufijo) return { action: `${verboSufijo} ${recurso.singular}`, target };

  const verbo = VERBOS[metodo] ?? metodo.toLowerCase();
  return { action: `${verbo} ${recurso.singular}`, target };
}

/** Saca el nombre de lo que se esta creando del cuerpo del pedido. */
function nombreDelCuerpo(cuerpo: unknown): string {
  if (!cuerpo || typeof cuerpo !== 'object') return '';
  const campos = cuerpo as Record<string, unknown>;
  for (const campo of ['name', 'topic', 'title']) {
    const valor = campos[campo];
    if (typeof valor === 'string' && valor.trim()) return valor.trim().slice(0, 120);
  }
  return '';
}

/**
 * Busca el nombre para que la fila diga "Mozzarella" y no un identificador.
 * Si la fila ya no existe (un borrado), se queda con el id y listo.
 */
function nombreDe(tabla: string, id: string): string {
  try {
    const columna = tabla === 'orders' ? 'code' : tabla === 'knowledge' ? 'topic' : 'name';
    return get<Record<string, string>>(`SELECT ${columna} AS valor FROM ${tabla} WHERE id = ?`, [id])?.valor ?? '';
  } catch {
    return '';
  }
}
