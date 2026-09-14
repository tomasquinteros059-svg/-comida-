import { all, get, jsonParse, run } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/http.js';
import type { CartLine, ServiceType } from './types.js';
import { consultarPagina, type OpcionesDePagina, type Pagina } from '../lib/paginacion.js';

export interface Conversation {
  id: string;
  channel: string;
  customer_name: string;
  cart: CartLine[];
  service_type: ServiceType;
  details: OrderDetails;
  order_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_trace: unknown[];
  rating: number | null;
  created_at: string;
}

/** Datos de entrega que el bot va juntando antes de confirmar. */
export interface OrderDetails {
  table_label?: string;
  address?: string;
  customer_phone?: string;
}

interface ConversationRow extends Omit<Conversation, 'cart' | 'details'> {
  cart: string;
  details: string;
}

const map = (row: ConversationRow): Conversation => ({
  ...row,
  cart: jsonParse<CartLine[]>(row.cart, []),
  details: jsonParse<OrderDetails>(row.details, {}),
});

export function createConversation(input: { channel?: string; customer_name?: string } = {}): Conversation {
  const id = newId('cnv');
  run('INSERT INTO conversations (id, channel, customer_name) VALUES (?,?,?)', [
    id,
    input.channel ?? 'web',
    input.customer_name ?? '',
  ]);
  return getConversationOrThrow(id);
}

export function getConversation(id: string): Conversation | undefined {
  const row = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id]);
  return row ? map(row) : undefined;
}

export function getConversationOrThrow(id: string): Conversation {
  const conversation = getConversation(id);
  if (!conversation) throw notFound('Conversacion');
  return conversation;
}

export function saveCart(id: string, cart: CartLine[]): void {
  run("UPDATE conversations SET cart = ?, updated_at = datetime('now') WHERE id = ?", [
    JSON.stringify(cart),
    id,
  ]);
}

export function updateConversation(id: string, patch: Partial<Conversation>): Conversation {
  const current = getConversationOrThrow(id);
  const next = { ...current, ...patch };
  run(
    `UPDATE conversations SET customer_name = ?, service_type = ?, order_id = ?, cart = ?,
       details = ?, updated_at = datetime('now') WHERE id = ?`,
    [
      next.customer_name,
      next.service_type,
      next.order_id,
      JSON.stringify(next.cart),
      JSON.stringify(next.details ?? {}),
      id,
    ],
  );
  return getConversationOrThrow(id);
}

/** Fusiona datos de entrega sin pisar los ya cargados con valores vacios. */
export function mergeDetails(id: string, patch: OrderDetails): OrderDetails {
  const current = getConversationOrThrow(id);
  const merged = { ...current.details, ...patch };
  run("UPDATE conversations SET details = ?, updated_at = datetime('now') WHERE id = ?", [
    JSON.stringify(merged),
    id,
  ]);
  return merged;
}

export function addMessage(input: {
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_trace?: unknown[];
}): Message {
  const id = newId('msg');
  run('INSERT INTO messages (id, conversation_id, role, content, tool_trace) VALUES (?,?,?,?,?)', [
    id,
    input.conversation_id,
    input.role,
    input.content,
    JSON.stringify(input.tool_trace ?? []),
  ]);
  return getMessages(input.conversation_id).find((m) => m.id === id)!;
}

export function getMessages(conversationId: string, limit = 50): Message[] {
  return all<Message & { tool_trace: string }>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at LIMIT ?',
    [conversationId, limit],
  ).map((row) => ({ ...row, tool_trace: jsonParse<unknown[]>(row.tool_trace, []) }));
}

export function rateMessage(messageId: string, rating: 1 | -1): void {
  run('UPDATE messages SET rating = ? WHERE id = ?', [rating, messageId]);
}

export const listConversations = (
  opciones: OpcionesDePagina = { limite: 50, desde: 0 },
): Pagina<Record<string, unknown>> =>
  consultarPagina(
    `c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
     (SELECT content FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message`,
    'FROM conversations c ORDER BY c.updated_at DESC',
    [],
    opciones,
  );

/** Conversaciones con feedback negativo: lo que hay que corregir en el bot. */
export const flaggedMessages = (
  opciones: OpcionesDePagina = { limite: 50, desde: 0 },
): Pagina<Record<string, unknown>> =>
  consultarPagina(
    'm.*, c.channel',
    `FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.rating = -1 ORDER BY m.created_at DESC`,
    [],
    opciones,
  );

export function recordDemandSignal(input: {
  kind: 'sin_stock' | 'no_esta_en_carta';
  query: string;
  product_id?: string | null;
  conversation_id?: string | null;
}): void {
  run(
    'INSERT INTO demand_signals (id, kind, query, product_id, conversation_id) VALUES (?,?,?,?,?)',
    [newId('dem'), input.kind, input.query, input.product_id ?? null, input.conversation_id ?? null],
  );
}
