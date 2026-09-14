import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { chat } from '../chat/engine.js';
import {
  createConversation,
  flaggedMessages,
  getConversationOrThrow,
  getMessages,
  listConversations,
  rateMessage,
} from '../domain/conversations.js';
import { priceCart } from '../domain/orders.js';
import { config, hasLLM } from '../config.js';
import { rateLimit } from '../lib/rateLimit.js';

/**
 * Lo que puede llamar cualquiera desde internet: mandar un mensaje y saber que
 * motor esta corriendo. Nada mas.
 */
export const chatPublicRouter = Router();

/**
 * La gestion de las conversaciones es del local, no del cliente: los mensajes
 * traen lo que la gente escribio (nombres, telefonos, direcciones) y no pueden
 * quedar del lado publico.
 */
export const chatAdminRouter = Router();

const chatBody = z.object({
  conversation_id: z.string().optional(),
  message: z.string().min(1, 'El mensaje no puede estar vacío').max(2000),
  channel: z.string().optional(),
  customer_name: z.string().optional(),
});

/**
 * Cada turno puede costar una llamada al modelo. Sin limite, cualquiera con un
 * bucle vacia el presupuesto del local en una tarde. Va sobre el POST y no
 * sobre todo /api/chat, para que el panel del local no gaste el cupo del
 * cliente cuando refresca las conversaciones.
 */
const limiteDelChat = rateLimit({
  ...config.chatRateLimit,
  message: 'Estas escribiendo muy rapido. Espera unos segundos y volve a intentar.',
});

chatPublicRouter.post(
  '/',
  limiteDelChat,
  route(async (req) => {
    const body = chatBody.parse(req.body);
    const conversationId =
      body.conversation_id ??
      createConversation({ channel: body.channel, customer_name: body.customer_name }).id;
    return chat(conversationId, body.message);
  }),
);

chatAdminRouter.post(
  '/conversations',
  route((req) => createConversation(req.body ?? {})),
);

chatAdminRouter.get(
  '/conversations',
  route(() => listConversations()),
);

chatAdminRouter.get(
  '/conversations/:id',
  route((req) => {
    const conversation = getConversationOrThrow(req.params.id!);
    const cart = conversation.cart.length ? priceCart(conversation.cart) : { lines: [], subtotal_cents: 0 };
    return { conversation, messages: getMessages(conversation.id), cart };
  }),
);

chatAdminRouter.post(
  '/messages/:id/rating',
  route((req) => {
    const { rating } = z.object({ rating: z.union([z.literal(1), z.literal(-1)]) }).parse(req.body);
    rateMessage(req.params.id!, rating);
    return { ok: true };
  }),
);

/** Mensajes marcados como malos: la cola de trabajo para mejorar el bot. */
chatAdminRouter.get(
  '/flagged',
  route(() => flaggedMessages()),
);

chatPublicRouter.get(
  '/engine',
  route(() => ({ engine: hasLLM() ? 'llm' : 'deterministico' })),
);
