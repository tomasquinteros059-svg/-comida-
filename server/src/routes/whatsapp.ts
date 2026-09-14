import { Router, type Request } from 'express';
import { chat } from '../chat/engine.js';
import {
  configWhatsapp,
  conversacionDelNumero,
  enviarWhatsapp,
  firmaValida,
  limpiarMensajesVistos,
  loQueFaltaDeWhatsapp,
  marcarComoVisto,
  mensajesDelWebhook,
  responderVerificacion,
  whatsappActivo,
} from '../domain/whatsapp.js';
import { route } from '../lib/http.js';

/**
 * El webhook de WhatsApp. Es publico por definicion —lo llama Meta— y por eso
 * lo unico que lo protege es la firma del cuerpo.
 */
export const whatsappRouter = Router();

/** Express guarda el cuerpo crudo en el parser; ver el montaje en index.ts. */
const cuerpoCrudo = (req: Request): Buffer | string =>
  (req as Request & { cuerpoCrudo?: Buffer }).cuerpoCrudo ?? JSON.stringify(req.body ?? {});

/**
 * Alta del webhook. Meta llama una vez con un desafio y hay que devolverlo tal
 * cual, en texto plano, solo si la palabra de verificacion coincide.
 */
whatsappRouter.get('/', (req, res) => {
  const desafio = responderVerificacion(req.query as Record<string, unknown>);
  if (desafio === null) {
    res.status(403).type('text/plain').send('No coincide la palabra de verificación');
    return;
  }
  res.type('text/plain').send(desafio);
});

/**
 * Los mensajes.
 *
 * Se contesta 200 enseguida y se procesa despues, a proposito: Meta reintenta
 * si tardamos, y una llamada al modelo puede tardar varios segundos. El
 * reintento no duplica nada porque cada mensaje se marca como visto antes de
 * procesarlo.
 */
whatsappRouter.post('/', (req, res) => {
  if (!whatsappActivo()) {
    res.status(503).json({ error: 'WhatsApp no está configurado' });
    return;
  }

  if (!firmaValida(cuerpoCrudo(req), req.header('x-hub-signature-256'))) {
    // Sin detalle: al que prueba firmas no hay que ayudarlo.
    res.status(401).json({ error: 'Firma inválida' });
    return;
  }

  const mensajes = mensajesDelWebhook(req.body);
  res.status(200).json({ recibidos: mensajes.length });

  for (const mensaje of mensajes) void atender(mensaje);
});

/** Toma un mensaje, lo pasa por el bot y contesta por WhatsApp. */
async function atender(mensaje: { id: string; de: string; texto: string; nombre: string }): Promise<void> {
  // Antes de procesar, no despues: si el bot tarda y Meta reintenta, el segundo
  // se descarta aca en vez de cocinar el pedido dos veces.
  if (!marcarComoVisto(mensaje.id)) return;

  try {
    const conversacion = conversacionDelNumero(mensaje.de, mensaje.nombre);
    const turno = await chat(conversacion, mensaje.texto);
    await enviarWhatsapp(mensaje.de, turno.reply);
  } catch (err) {
    console.error(`[whatsapp] no pude atender ${mensaje.id}:`, err);
    // Que el cliente sepa que pasó algo, en vez de quedarse esperando.
    try {
      await enviarWhatsapp(
        mensaje.de,
        'Perdón, se me complicó procesar tu mensaje. ¿Me lo escribís de nuevo?',
      );
    } catch {
      // Si tampoco se puede contestar, no hay mucho mas que hacer.
    }
  }
}

/** Estado, para el panel. Nunca devuelve el token ni la clave secreta. */
export const whatsappEstado = () => {
  const c = configWhatsapp();
  return {
    activo: whatsappActivo(),
    falta: loQueFaltaDeWhatsapp(),
    numero_id: c.phoneNumberId ? `…${c.phoneNumberId.slice(-4)}` : '',
    version: c.version,
  };
};

export { limpiarMensajesVistos };
