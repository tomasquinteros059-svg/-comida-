import { formatMoney } from '../lib/money.js';
import { config } from '../config.js';
import {
  getProduct,
  listProducts,
  getModifiersForProduct,
  searchProducts,
} from '../domain/menu.js';
import { priceCart, createOrder } from '../domain/orders.js';
import { checkAvailability, orderableNow } from '../domain/stock.js';
import { menuPerformance } from '../domain/analytics.js';
import {
  getConversationOrThrow,
  mergeDetails,
  recordDemandSignal,
  saveCart,
  updateConversation,
} from '../domain/conversations.js';
import type { CartLine, ServiceType } from '../domain/types.js';

export interface ToolContext {
  conversationId: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (input: Record<string, any>, ctx: ToolContext) => unknown;
}

const money = (cents: number) => formatMoney(cents, config.currency);

/**
 * Ficha del producto tal como la lee el modelo. `disponible` refleja el stock
 * libre en este instante, no solo la marca de la carta: si otro cliente ya
 * tiene comprometidas las ultimas unidades, aca figura como no disponible.
 */
const describeProduct = (id: string, orderable?: Map<string, boolean>) => {
  const product = getProduct(id);
  if (!product) return null;
  return {
    id: product.id,
    nombre: product.name,
    descripcion: product.description,
    precio: money(product.price_cents),
    categoria: product.category_name,
    disponible: orderable ? (orderable.get(product.id) ?? product.available) : product.available,
    etiquetas: product.tags,
    alergenos: product.allergens,
    opciones: getModifiersForProduct(product.id).map((g) => ({
      grupo: g.name,
      elegir: `${g.min_select}-${g.max_select}`,
      opciones: g.modifiers
        .filter((m) => m.available)
        .map((m) => ({ id: m.id, nombre: m.name, extra: money(m.price_cents) })),
    })),
  };
};

/** Resumen del carrito valorizado, tal como lo ve el cliente. */
function cartSummary(conversationId: string) {
  const conversation = getConversationOrThrow(conversationId);
  if (!conversation.cart.length) {
    return { vacio: true, lineas: [], total: money(0), mensaje: 'El pedido está vacío.' };
  }
  const { lines, subtotal_cents } = priceCart(conversation.cart);
  return {
    vacio: false,
    tipo_servicio: conversation.service_type,
    lineas: lines.map((l, index) => ({
      indice: index,
      producto_id: l.product_id,
      producto: l.product_name,
      cantidad: l.qty,
      opciones: l.modifiers.map((m) => m.name),
      nota: l.note,
      subtotal: money(l.line_total_cents),
      disponible: l.available,
    })),
    total: money(subtotal_cents),
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'buscar_en_carta',
    description:
      'Busca productos en la carta por nombre, ingrediente, categoria o etiqueta. Usalo SIEMPRE ' +
      'antes de agregar algo al pedido, para obtener el id real del producto y sus opciones. ' +
      'Tambien devuelve productos sin stock, para poder ofrecer alternativas.',
    input_schema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'Lo que pidio el cliente, tal cual lo dijo.' },
      },
      required: ['consulta'],
    },
    execute: ({ consulta }, ctx) => {
      const matches = searchProducts(String(consulta));
      if (!matches.length) {
        return {
          resultados: [],
          mensaje: 'No hay nada parecido en la carta. Ofrece alternativas de categorias similares.',
        };
      }
      const orderable = orderableNow(ctx.conversationId);
      return { resultados: matches.map((m) => describeProduct(m.product.id, orderable)) };
    },
  },

  {
    name: 'ver_carta',
    description:
      'Devuelve la carta completa agrupada por categoria. Usalo cuando el cliente pide ver el menu ' +
      'o pregunta que hay, no para buscar un producto puntual.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', description: 'Opcional: filtra por nombre de categoria.' },
      },
    },
    execute: ({ categoria }, ctx) => {
      const products = listProducts({ onlyActive: true });
      const filtered = categoria
        ? products.filter((p) => (p.category_name ?? '').toLowerCase().includes(String(categoria).toLowerCase()))
        : products;
      const orderable = orderableNow(ctx.conversationId);
      const grouped: Record<string, unknown[]> = {};
      for (const p of filtered) {
        const key = p.category_name ?? 'Otros';
        (grouped[key] ??= []).push({
          id: p.id,
          nombre: p.name,
          precio: money(p.price_cents),
          descripcion: p.description,
          disponible: orderable.get(p.id) ?? p.available,
        });
      }
      return grouped;
    },
  },

  {
    name: 'agregar_al_pedido',
    description:
      'Agrega un producto al pedido en curso. Usa el id exacto devuelto por buscar_en_carta. ' +
      'Si el producto no esta disponible, la herramienta lo rechaza y registra la demanda perdida.',
    input_schema: {
      type: 'object',
      properties: {
        producto_id: { type: 'string' },
        cantidad: { type: 'integer', minimum: 1, default: 1 },
        opciones_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids de los modificadores elegidos (tamanio, extras, etc).',
        },
        nota: { type: 'string', description: 'Aclaraciones para cocina: "sin cebolla", "bien cocido".' },
      },
      required: ['producto_id'],
    },
    execute: ({ producto_id, cantidad, opciones_ids, nota }, ctx) => {
      const product = getProduct(String(producto_id));
      if (!product || !product.active) {
        return { ok: false, error: 'Ese producto no existe en la carta. Volvé a buscar con buscar_en_carta.' };
      }

      const qty = Math.max(1, Math.floor(Number(cantidad ?? 1)));
      const line: CartLine = {
        product_id: product.id,
        qty,
        modifier_ids: Array.isArray(opciones_ids) ? opciones_ids.map(String) : [],
        note: nota ? String(nota) : '',
      };

      const orderable = orderableNow(ctx.conversationId);
      if (!(orderable.get(product.id) ?? product.available)) {
        recordDemandSignal({
          kind: 'sin_stock',
          query: product.name,
          product_id: product.id,
          conversation_id: ctx.conversationId,
        });
        const alternatives = searchProducts(product.category_name ?? product.name, 4)
          .filter((m) => (orderable.get(m.product.id) ?? m.product.available) && m.product.id !== product.id)
          .map((m) => ({ id: m.product.id, nombre: m.product.name, precio: money(m.product.price_cents) }));
        return {
          ok: false,
          error: `${product.name} no está disponible ahora.`,
          alternativas: alternatives,
          instruccion: 'Pedile disculpas al cliente y ofrecele estas alternativas.',
        };
      }

      // Chequeamos el carrito completo: dos unidades pueden entrar de a una y
      // no alcanzar juntas. Se descuentan ademas los insumos que retienen los
      // carritos de otras conversaciones abiertas.
      const conversation = getConversationOrThrow(ctx.conversationId);
      const nextCart = [...conversation.cart, line];
      const check = checkAvailability(nextCart, { conversationId: ctx.conversationId });
      if (!check.ok) {
        recordDemandSignal({
          kind: 'sin_stock',
          query: product.name,
          product_id: product.id,
          conversation_id: ctx.conversationId,
        });
        return {
          ok: false,
          error: `No alcanza el stock para ${qty} x ${product.name}.`,
          faltantes: check.shortages.map((s) => `${s.ingredient_name} (faltan ${s.missing} ${s.unit})`),
          instruccion: 'Ofrecé una cantidad menor u otro producto.',
        };
      }

      saveCart(ctx.conversationId, nextCart);
      return { ok: true, agregado: `${qty} x ${product.name}`, pedido: cartSummary(ctx.conversationId) };
    },
  },

  {
    name: 'quitar_del_pedido',
    description: 'Quita una linea del pedido usando el indice que devuelve ver_pedido.',
    input_schema: {
      type: 'object',
      properties: { indice: { type: 'integer', minimum: 0 } },
      required: ['indice'],
    },
    execute: ({ indice }, ctx) => {
      const conversation = getConversationOrThrow(ctx.conversationId);
      const index = Number(indice);
      if (!Number.isInteger(index) || index < 0 || index >= conversation.cart.length) {
        return { ok: false, error: 'Ese índice no existe en el pedido.' };
      }
      const cart = conversation.cart.filter((_, i) => i !== index);
      saveCart(ctx.conversationId, cart);
      return { ok: true, pedido: cartSummary(ctx.conversationId) };
    },
  },

  {
    name: 'ver_pedido',
    description: 'Devuelve el pedido en curso con cantidades y total.',
    input_schema: { type: 'object', properties: {} },
    execute: (_input, ctx) => cartSummary(ctx.conversationId),
  },

  {
    name: 'datos_del_pedido',
    description:
      'Guarda los datos de entrega del pedido: nombre, si es para comer en el local / llevar / ' +
      'delivery, mesa, direccion y telefono. Pedilos antes de confirmar.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        tipo_servicio: { type: 'string', enum: ['local', 'takeaway', 'delivery'] },
        mesa: { type: 'string' },
        direccion: { type: 'string' },
        telefono: { type: 'string' },
      },
    },
    execute: (input, ctx) => {
      const patch: Record<string, unknown> = {};
      if (input.nombre) patch.customer_name = String(input.nombre);
      if (input.tipo_servicio) patch.service_type = String(input.tipo_servicio) as ServiceType;
      if (Object.keys(patch).length) updateConversation(ctx.conversationId, patch);
      // mesa/direccion/telefono viajan al pedido recien al confirmarlo
      mergeDetails(ctx.conversationId, {
        ...(input.mesa ? { table_label: String(input.mesa) } : {}),
        ...(input.direccion ? { address: String(input.direccion) } : {}),
        ...(input.telefono ? { customer_phone: String(input.telefono) } : {}),
      });
      return { ok: true, guardado: input };
    },
  },

  {
    name: 'confirmar_pedido',
    description:
      'Cierra el pedido y lo manda a cocina. Confirmalo solo despues de repetirle el pedido al ' +
      'cliente y de que te diga que si. Devuelve el numero de pedido y el tiempo estimado.',
    input_schema: {
      type: 'object',
      properties: {
        nota: { type: 'string', description: 'Aclaracion general para cocina.' },
      },
    },
    execute: ({ nota }, ctx) => {
      const conversation = getConversationOrThrow(ctx.conversationId);
      if (!conversation.cart.length) {
        return { ok: false, error: 'El pedido está vacío, no hay nada que confirmar.' };
      }
      if (conversation.order_id) {
        return { ok: false, error: 'Este pedido ya fue confirmado.' };
      }

      const details = conversation.details ?? {};
      if (conversation.service_type === 'delivery' && !details.address) {
        return { ok: false, error: 'Falta la dirección de entrega. Pedísela al cliente.' };
      }

      try {
        const order = createOrder({
          lines: conversation.cart,
          channel: 'chat',
          service_type: conversation.service_type,
          customer_name: conversation.customer_name,
          conversation_id: ctx.conversationId,
          note: nota ? String(nota) : '',
          confirm: true,
          actor: 'chatbot',
          ...details,
        });
        updateConversation(ctx.conversationId, { order_id: order.id, cart: [], details: {} });
        const minutes = Math.max(5, Math.ceil((order.prep_seconds ?? 600) / 60));
        return {
          ok: true,
          numero_pedido: order.daily_number,
          codigo: order.code,
          total: money(order.total_cents),
          demora_estimada_min: minutes,
          estado: order.status,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'No se pudo confirmar';
        return { ok: false, error: message, detalle: (err as { details?: unknown }).details };
      }
    },
  },

  {
    name: 'recomendar',
    description:
      'Sugiere productos. Sin criterio devuelve los mas vendidos; con criterio filtra por ' +
      'etiqueta (vegetariano, sin_tacc, picante) o categoria.',
    input_schema: {
      type: 'object',
      properties: { criterio: { type: 'string' }, cantidad: { type: 'integer', default: 3 } },
    },
    execute: ({ criterio, cantidad }, ctx) => {
      const limit = Math.min(8, Math.max(1, Number(cantidad ?? 3)));
      const orderable = orderableNow(ctx.conversationId);
      const available = new Set(
        listProducts({ onlyActive: true }).filter((p) => orderable.get(p.id)).map((p) => p.id),
      );

      if (criterio) {
        const matches = searchProducts(String(criterio), 12).filter((m) => available.has(m.product.id));
        if (matches.length) return { sugerencias: matches.slice(0, limit).map((m) => describeProduct(m.product.id)) };
      }

      const ranked = menuPerformance(30)
        .filter((p) => available.has(p.product_id))
        .sort((a, b) => b.qty - a.qty || b.margin_cents - a.margin_cents)
        .slice(0, limit);
      return { sugerencias: ranked.map((p) => describeProduct(p.product_id)).filter(Boolean) };
    },
  },

  {
    name: 'registrar_pedido_no_disponible',
    description:
      'Registra que el cliente pidio algo que no tenemos (ni en la carta ni en stock). El local usa ' +
      'esta senal para reponer o sumar productos. Usalo antes de disculparte por no tenerlo.',
    input_schema: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'Lo que pidio el cliente.' },
        motivo: { type: 'string', enum: ['sin_stock', 'no_esta_en_carta'] },
      },
      required: ['consulta'],
    },
    execute: ({ consulta, motivo }, ctx) => {
      recordDemandSignal({
        kind: motivo === 'sin_stock' ? 'sin_stock' : 'no_esta_en_carta',
        query: String(consulta),
        conversation_id: ctx.conversationId,
      });
      return { ok: true, registrado: consulta };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): unknown {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { ok: false, error: `Herramienta desconocida: ${name}` };
  try {
    return tool.execute(input, ctx);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Error ejecutando la herramienta' };
  }
}
