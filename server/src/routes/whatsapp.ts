import { Router, type Request } from 'express';
import { chat } from '../chat/engine.js';
import {
  configWhatsapp,
  conversacionDelNumero,
  enviarWhatsapp,
  firmaValida,
  limpiarMensajesVistos,
  loQueFaltaDeWhatsapp,
  marcarComoLeidoEnWhatsapp,
  marcarComoVisto,
  mensajesDelWebhook,
  type MensajeEntrante,
  responderVerificacion,
  whatsappActivo,
  probarWhatsapp,
  CREDENCIALES,
  guardarCredenciales,
  origenDeCredenciales,
} from '../domain/whatsapp.js';
import { sePuedeGuardar } from '../domain/secretos.js';
import { route } from '../lib/http.js';
import { enLocal, hayVariosLocales, localPorWhatsapp } from '../db/locales.js';

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

  for (const mensaje of mensajes) void atenderEnSuLocal(mensaje);
});

/**
 * Manda el mensaje a la cocina que corresponde.
 *
 * Meta pega SIEMPRE en la misma direccion, asi que el ruteo por dominio —que
 * es como entra todo lo demas— no sirve: para Meta el Host es siempre el
 * mismo. Lo unico que distingue un local de otro es el numero que recibio el
 * mensaje, que viene en el cuerpo del webhook.
 *
 * Con un solo local no cambia nada. Con dos, sin esto, los pedidos de los dos
 * caen en la cocina del primero.
 */
async function atenderEnSuLocal(mensaje: MensajeEntrante): Promise<void> {
  const local = mensaje.paraNumero ? localPorWhatsapp(mensaje.paraNumero) : undefined;

  if (!local) {
    // Sin numero cargado no hay a quien mandarselo. Con un solo local eso es
    // lo normal —nadie lo cargo porque no hacia falta— y va al de siempre.
    if (hayVariosLocales() && mensaje.paraNumero) {
      console.error(
        `[whatsapp] llegó un mensaje al número ${mensaje.paraNumero} y ningún local lo tiene ` +
          `cargado. Cargalo en Locales, o el pedido va a caer en la cocina equivocada.`,
      );
    }
    return atender(mensaje);
  }

  // El contexto sobrevive a los `await` de adentro: AsyncLocalStorage lo
  // propaga por la cadena de promesas, asi que todas las consultas de
  // `atender` —incluidas las de despues de llamar al modelo— van a la base de
  // ESTE local. Hay un test que lo comprueba contra dos bases de verdad, en
  // whatsapp-locales.test.ts, porque de esto depende en que cocina cae el
  // pedido y no es algo para dar por sentado.
  return enLocal(local.slug, () => atender(mensaje));
}

/** Toma un mensaje, lo pasa por el bot y contesta por WhatsApp. */
async function atender(mensaje: MensajeEntrante): Promise<void> {
  // Antes de procesar, no despues: si el bot tarda y Meta reintenta, el segundo
  // se descarta aca en vez de cocinar el pedido dos veces.
  if (!marcarComoVisto(mensaje.id)) return;

  // El doble tilde azul, mientras el bot piensa. No se espera: si tarda o
  // falla, no tiene por que demorar la respuesta.
  void marcarComoLeidoEnWhatsapp(mensaje.id);

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
    // De donde sale cada una. El panel usa esto para no volver a pedir lo que
    // ya esta, y para no dejar editar lo que manda el servidor.
    origen: origenDeCredenciales(),
    // Con las credenciales en el .env, el panel no las puede cambiar: gana la
    // variable de entorno.
    se_puede_cargar: sePuedeGuardar(),
  };
};

/** Guarda lo que cargaron en el panel. Nunca devuelve lo guardado. */
export const guardarDesdeElPanel = (body: unknown) => {
  const entrada = (body ?? {}) as Record<string, unknown>;
  const limpio: Record<string, string> = {};
  for (const { campo } of CREDENCIALES) {
    const valor = entrada[campo];
    if (typeof valor === 'string') limpio[campo] = valor;
  }
  guardarCredenciales(limpio);
  return whatsappEstado();
};

/** Revisa la conexion con Meta y dice que falta, paso por paso. */
export const probarConexion = () => probarWhatsapp();

export { limpiarMensajesVistos };
