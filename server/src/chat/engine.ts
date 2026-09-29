import Anthropic from '@anthropic-ai/sdk';
import { claveDeChat, config, hasLLM, proveedorDeChat } from '../config.js';
import { addMessage, getConversationOrThrow, getMessages } from '../domain/conversations.js';
import { buildSystemPrompt } from './prompt.js';
import { respondDeterministic } from './fallback.js';
import { TOOLS, runTool } from './tools.js';
import { responderConGemini } from './gemini.js';

export interface ChatTurn {
  conversation_id: string;
  reply: string;
  message_id: string;
  engine: 'llm' | 'deterministico';
  trace: { tool: string; input: unknown; output: unknown }[];
  cart_size: number;
  order_id: string | null;
}

/** Cuantas rondas de herramientas permitimos antes de cortar. */
const MAX_TOOL_ROUNDS = 6;
/** Cuantos mensajes previos mandamos como contexto. */
const HISTORY_LIMIT = 20;
/**
 * Techo de la respuesta. Las respuestas del bot son de dos o tres frases; el
 * limite existe para que un error no genere (y cobre) una parrafada.
 */
const MAX_TOKENS = 2048;

let client: Anthropic | null = null;
let claveDelCliente = '';
/**
 * El cliente se rehace si cambió la clave: ahora se puede cargar desde el
 * panel, y guardarla no tiene por qué obligar a reiniciar el servidor.
 */
const anthropic = () => {
  const clave = claveDeChat('anthropic');
  if (!client || claveDelCliente !== clave) {
    client = new Anthropic({ apiKey: clave });
    claveDelCliente = clave;
  }
  return client;
};

export async function chat(conversationId: string, userMessage: string): Promise<ChatTurn> {
  getConversationOrThrow(conversationId);
  addMessage({ conversation_id: conversationId, role: 'user', content: userMessage });

  const result = hasLLM()
    ? await conModelo(conversationId)
    : respondDeterministic(userMessage, conversationId);

  const stored = addMessage({
    conversation_id: conversationId,
    role: 'assistant',
    content: result.reply,
    tool_trace: result.trace,
  });

  const conversation = getConversationOrThrow(conversationId);
  return {
    conversation_id: conversationId,
    reply: result.reply,
    message_id: stored.id,
    engine: hasLLM() ? 'llm' : 'deterministico',
    trace: result.trace,
    cart_size: conversation.cart.reduce((sum, l) => sum + l.qty, 0),
    order_id: conversation.order_id,
  };
}

interface EngineResult {
  reply: string;
  trace: { tool: string; input: unknown; output: unknown }[];
}

/**
 * El unico modo de saber si el cache esta funcionando es mirar el uso: si deja
 * de funcionar no hay error, solo una factura mas alta. Por eso se registra en
 * cada llamada en vez de confiar en que quedo bien configurado.
 */
function logCacheUsage(usage: Anthropic.Usage): void {
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const fresh = usage.input_tokens;
  console.log(
    `[chat] tokens: ${fresh} sin cache · ${written} escritos al cache · ${read} leidos del cache · ${usage.output_tokens} de salida`,
  );
}

/**
 * Manda el turno al proveedor configurado.
 *
 * Los dos caminos terminan igual —texto y traza— así que de acá para arriba
 * nadie se entera de cuál contestó. Si el modelo falla, los dos caen al motor
 * determinista: un bot que no contesta es peor que uno que contesta con
 * reglas.
 */
async function conModelo(conversationId: string): Promise<EngineResult> {
  if (proveedorDeChat() === 'gemini') return conGemini(conversationId);
  return respondWithLLM(conversationId);
}

async function conGemini(conversationId: string): Promise<EngineResult> {
  const trace: EngineResult['trace'] = [];
  try {
    const prompt = buildSystemPrompt(conversationId);
    const resultado = await responderConGemini({
      // Gemini no tiene el corte de cache de Anthropic, así que las dos partes
      // del prompt van juntas. El contenido es el mismo.
      sistema: `${prompt.stable}

${prompt.volatile}`,
      historia: getMessages(conversationId, HISTORY_LIMIT).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      herramientas: TOOLS,
      correr: (nombre, entrada) => runTool(nombre, entrada, { conversationId }),
      maxRondas: MAX_TOOL_ROUNDS,
      maxTokens: MAX_TOKENS,
    });
    return { reply: resultado.reply, trace: resultado.trace };
  } catch (err) {
    console.error('[chat] falló Gemini, uso el motor determinista:', err);
    const last = getMessages(conversationId, 1000).filter((m) => m.role === 'user').at(-1);
    const fallback = respondDeterministic(last?.content ?? '', conversationId);
    return { reply: fallback.reply, trace: [...trace, ...fallback.trace] };
  }
}

async function respondWithLLM(conversationId: string): Promise<EngineResult> {
  const history = getMessages(conversationId, HISTORY_LIMIT);
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const tools: Anthropic.Tool[] = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  }));

  const trace: EngineResult['trace'] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const prompt = buildSystemPrompt(conversationId);

      const response = await anthropic().messages.create({
        model: config.chatModel,
        max_tokens: MAX_TOKENS,
        // El orden de render es tools -> system -> messages, asi que el punto
        // de cache al final del bloque estable cachea las herramientas y la
        // carta juntas. Lo que cambia con cada venta va despues, sin marca.
        system: [
          { type: 'text', text: prompt.stable, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: prompt.volatile },
        ],
        output_config: { effort: config.chatEffort },
        tools,
        messages,
      });

      logCacheUsage(response.usage);

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (!toolUses.length) {
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();
        return { reply: text || 'Perdon, no te entendi. ¿Me lo repetis?', trace };
      }

      messages.push({ role: 'assistant', content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = toolUses.map((use) => {
        const output = runTool(use.name, use.input as Record<string, unknown>, { conversationId });
        trace.push({ tool: use.name, input: use.input, output });
        return {
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(output),
        };
      });

      messages.push({ role: 'user', content: results });
    }

    // Se acabaron las rondas: cortamos con algo util en vez de colgarnos.
    return {
      reply: 'Se me complico procesar eso. ¿Me lo decis de nuevo, mas simple?',
      trace,
    };
  } catch (err) {
    console.error('[chat] fallo el modelo, uso el motor deterministico:', err);
    const last = getMessages(conversationId, 1000).filter((m) => m.role === 'user').at(-1);
    const fallback = respondDeterministic(last?.content ?? '', conversationId);
    return { reply: fallback.reply, trace: [...trace, ...fallback.trace] };
  }
}
