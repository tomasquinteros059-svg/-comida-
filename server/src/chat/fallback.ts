import { getConversationOrThrow } from '../domain/conversations.js';
import { runTool } from './tools.js';
import { normalize } from '../lib/text.js';

/**
 * Motor determinista: entiende los pedidos con reglas y coincidencia difusa.
 * Se usa cuando no hay ANTHROPIC_API_KEY, para que el sistema sea demostrable
 * y testeable sin depender de la red.
 */

const NUMBER_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, media: 1, medio: 1,
};

const intent = (text: string, words: string[]) => words.some((w) => text.includes(w));

export interface FallbackResult {
  reply: string;
  trace: { tool: string; input: unknown; output: unknown }[];
}

export function respondDeterministic(message: string, conversationId: string): FallbackResult {
  const text = normalize(message);
  const trace: FallbackResult['trace'] = [];
  const call = (tool: string, input: Record<string, unknown> = {}) => {
    const output = runTool(tool, input, { conversationId });
    trace.push({ tool, input, output });
    return output as any;
  };

  if (intent(text, ['carta', 'menu', 'que tienen', 'que hay'])) {
    const menu = call('ver_carta');
    const lines = Object.entries(menu as Record<string, { nombre: string; precio: string; disponible: boolean }[]>)
      .map(([cat, items]) => {
        const list = items
          .map((i) => `  • ${i.nombre} — ${i.precio}${i.disponible ? '' : ' (sin stock)'}`)
          .join('\n');
        return `${cat}:\n${list}`;
      });
    return { reply: `Esto es lo que tenemos hoy:\n\n${lines.join('\n\n')}`, trace };
  }

  if (intent(text, ['mi pedido', 'ver pedido', 'que pedi', 'cuanto va', 'cuanto es', 'total'])) {
    const cart = call('ver_pedido');
    return { reply: formatCart(cart), trace };
  }

  if (intent(text, ['confirmar', 'confirmo', 'listo dale', 'cerra el pedido', 'eso es todo', 'nada mas'])) {
    const result = call('confirmar_pedido');
    if (result.ok) {
      return {
        reply: `Listo, tu pedido es el número ${result.numero_pedido}. Total ${result.total}. ` +
          `Sale en unos ${result.demora_estimada_min} minutos.`,
        trace,
      };
    }
    return { reply: `No pude cerrarlo: ${result.error}`, trace };
  }

  if (intent(text, ['recomenda', 'sugeri', 'que me recomendas', 'lo mas pedido'])) {
    const result = call('recomendar', { cantidad: 3 });
    const names = (result.sugerencias ?? []).map((s: any) => `${s.nombre} (${s.precio})`).join(', ');
    return { reply: names ? `Te recomiendo: ${names}.` : 'Todavía no tengo datos para recomendarte.', trace };
  }

  if (intent(text, ['sacar', 'quitar', 'borra', 'saca'])) {
    const cart = call('ver_pedido');
    if (cart.vacio) return { reply: 'El pedido está vacío, no hay nada para sacar.', trace };
    const target = findLineToRemove(text, cart.lineas);
    if (target === null) return { reply: '¿Cuál de los productos querés sacar?', trace };
    const result = call('quitar_del_pedido', { indice: target });
    return { reply: `Lo saqué.\n\n${formatCart(result.pedido)}`, trace };
  }

  // Por defecto: interpretarlo como un pedido de productos.
  const requests = parseOrderRequest(message);
  if (!requests.length) {
    return {
      reply: 'Contame qué te gustaría pedir y te lo agrego. Si querés, escribí "carta" para ver el menú.',
      trace,
    };
  }

  const added: string[] = [];
  const problems: string[] = [];

  for (const request of requests) {
    const search = call('buscar_en_carta', { consulta: request.query });
    const first = search.resultados?.[0];
    if (!first) {
      call('registrar_pedido_no_disponible', { consulta: request.query, motivo: 'no_esta_en_carta' });
      problems.push(`No tenemos "${request.query}".`);
      continue;
    }
    const result = call('agregar_al_pedido', { producto_id: first.id, cantidad: request.qty });
    if (result.ok) {
      added.push(result.agregado);
    } else {
      const alt = (result.alternativas ?? []).map((a: any) => a.nombre).slice(0, 2).join(' o ');
      problems.push(`${result.error}${alt ? ` Te puedo ofrecer ${alt}.` : ''}`);
    }
  }

  const cart = call('ver_pedido');
  const parts: string[] = [];
  if (added.length) parts.push(`Agregué ${added.join(' y ')}.`);
  if (problems.length) parts.push(problems.join(' '));
  if (added.length) parts.push(`Van ${cart.total}. ¿Agregás algo más o lo confirmo?`);
  return { reply: parts.join(' ') || 'No llegué a entender el pedido, ¿me lo repetís?', trace };
}

interface ParsedRequest {
  qty: number;
  query: string;
}

/** Parte "quiero 2 empanadas y una coca" en pedidos con cantidad. */
export function parseOrderRequest(message: string): ParsedRequest[] {
  const cleaned = normalize(message)
    .replace(/^(hola|buenas|buenos dias|buenas tardes|buenas noches)\s*/i, '')
    .replace(/\b(quiero|querria|me das|dame|traeme|agregame|agrega|sumale|ponme|pone|necesito|para mi)\b/g, ' ');

  const chunks = cleaned
    .split(/\s+(?:y|mas|tambien|ademas|,)\s+/)
    .map((c) => c.trim())
    .filter(Boolean);

  const requests: ParsedRequest[] = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(.*)$/);
    let qty = 1;
    let query = chunk;
    if (match) {
      const raw = match[1]!;
      qty = /^\d+$/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw] ?? 1);
      query = match[2]!.trim();
    }
    if (query.length < 3) continue;
    // Los que no matchean tambien entran: sirven para registrar demanda perdida.
    requests.push({ qty: Math.min(qty, 50), query });
  }
  return requests;
}

function findLineToRemove(text: string, lines: { indice: number; producto: string }[]): number | null {
  for (const line of lines) {
    if (text.includes(normalize(line.producto).split(' ')[0]!)) return line.indice;
  }
  return lines.length === 1 ? lines[0]!.indice : null;
}

function formatCart(cart: any): string {
  if (!cart || cart.vacio) return 'Todavía no pediste nada.';
  const lines = cart.lineas
    .map((l: any) => `  • ${l.cantidad} x ${l.producto} — ${l.subtotal}`)
    .join('\n');
  return `Tu pedido:\n${lines}\n\nTotal: ${cart.total}`;
}

/** Solo para tests / diagnostico. */
export const _internals = { parseOrderRequest, getConversationOrThrow };
