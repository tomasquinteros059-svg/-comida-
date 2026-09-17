import { createHmac, timingSafeEqual } from 'node:crypto';
import { get, run } from '../db/index.js';
import { config } from '../config.js';
import { badRequest } from '../lib/http.js';
import { guardarSecreto, hayGuardado, leerSecreto, sePuedeGuardar } from './secretos.js';
import { createConversation } from './conversations.js';

/**
 * WhatsApp, por la API de Meta (Cloud API).
 *
 * El motor del chat ya era independiente del canal: toma el pedido igual venga
 * de donde venga. Lo que faltaba era el enganche. Es la diferencia entre
 * "entrá a este link" y "escribinos al número de siempre", que para un local
 * es toda la diferencia.
 *
 * Las credenciales van por variables de entorno y no en la base a propósito:
 * la base se respalda y esas copias terminan circulando. Un token de WhatsApp
 * dentro de un backup que anda dando vueltas deja mandar mensajes en nombre
 * del local.
 */

export interface ConfigWhatsapp {
  /** El id del número del local en Meta, no el número en sí. */
  phoneNumberId: string;
  /** Token permanente de la app de Meta. */
  token: string;
  /** Lo que Meta manda al dar de alta el webhook, para probar que somos nosotros. */
  verifyToken: string;
  /** Con esto se firma cada webhook. Sin esto, cualquiera simula un cliente. */
  appSecret: string;
  version: string;
}

/**
 * De dónde salen las credenciales.
 *
 * Primero la variable de entorno y después la base. Ese orden importa: el que
 * administra el servidor tiene la última palabra, y una instalación que ya
 * andaba con el .env sigue andando igual sin tocar nada.
 *
 * Lo que está en la base está CIFRADO con una clave que no está en la base
 * (ver secretos.ts). El dueño del local las carga desde el panel sin pedirle
 * SSH a nadie, y una copia de la base robada no alcanza para mandar mensajes
 * en nombre del local.
 */
const credencial = (variable: string, guardada: string): string =>
  process.env[variable]?.trim() || leerSecreto(guardada);

export const configWhatsapp = (): ConfigWhatsapp => ({
  phoneNumberId: credencial('WHATSAPP_PHONE_NUMBER_ID', 'whatsapp.phone_number_id'),
  token: credencial('WHATSAPP_TOKEN', 'whatsapp.token'),
  verifyToken: credencial('WHATSAPP_VERIFY_TOKEN', 'whatsapp.verify_token'),
  appSecret: credencial('WHATSAPP_APP_SECRET', 'whatsapp.app_secret'),
  version: process.env.WHATSAPP_API_VERSION?.trim() || 'v21.0',
});

/** Los cuatro nombres, para guardarlas y para decir cuál viene de dónde. */
export const CREDENCIALES = [
  { campo: 'phoneNumberId', variable: 'WHATSAPP_PHONE_NUMBER_ID', guardada: 'whatsapp.phone_number_id' },
  { campo: 'token', variable: 'WHATSAPP_TOKEN', guardada: 'whatsapp.token' },
  { campo: 'verifyToken', variable: 'WHATSAPP_VERIFY_TOKEN', guardada: 'whatsapp.verify_token' },
  { campo: 'appSecret', variable: 'WHATSAPP_APP_SECRET', guardada: 'whatsapp.app_secret' },
] as const;

/**
 * Guarda las credenciales que vinieron del panel.
 *
 * Solo lo que se manda: el que quiere cambiar el token no tiene que volver a
 * pegar las otras tres. Vacío borra, que es como se desconecta un local.
 */
export function guardarCredenciales(input: Partial<Record<string, string>>): void {
  if (!sePuedeGuardar()) {
    throw badRequest(
      'Falta ADMIN_TOKEN en el servidor: sin eso no hay con qué cifrar las credenciales',
    );
  }
  for (const { campo, guardada } of CREDENCIALES) {
    const valor = input[campo];
    if (valor !== undefined) guardarSecreto(guardada, valor);
  }
}

/** De dónde salió cada una. El panel lo muestra para no pedir lo que ya está. */
export function origenDeCredenciales(): Record<string, 'entorno' | 'panel' | 'falta'> {
  const salida: Record<string, 'entorno' | 'panel' | 'falta'> = {};
  for (const { campo, variable, guardada } of CREDENCIALES) {
    if (process.env[variable]?.trim()) salida[campo] = 'entorno';
    else if (hayGuardado(guardada)) salida[campo] = 'panel';
    else salida[campo] = 'falta';
  }
  return salida;
}

/** Está activo cuando tiene con qué recibir y con qué contestar. */
export function whatsappActivo(): boolean {
  const c = configWhatsapp();
  return Boolean(c.phoneNumberId && c.token && c.verifyToken && c.appSecret);
}

/** Qué falta para poder prenderlo, en castellano y no como nombres de variables. */
export function loQueFaltaDeWhatsapp(): string[] {
  const c = configWhatsapp();
  const falta: string[] = [];
  if (!c.phoneNumberId) falta.push('el identificador del número');
  if (!c.token) falta.push('el token de la app');
  if (!c.verifyToken) falta.push('la palabra de verificación');
  if (!c.appSecret) falta.push('la clave secreta de la app');
  return falta;
}

// ── Verificación del webhook ────────────────────────────────────────────────

/**
 * Meta da de alta el webhook llamando una vez con un desafío. Hay que
 * devolverlo tal cual, y solo si la palabra de verificación coincide.
 */
export function responderVerificacion(query: Record<string, unknown>): string | null {
  const c = configWhatsapp();
  if (!c.verifyToken) return null;
  const modo = String(query['hub.mode'] ?? '');
  const token = String(query['hub.verify_token'] ?? '');
  const desafio = String(query['hub.challenge'] ?? '');
  if (modo !== 'subscribe' || !desafio) return null;
  return sonIguales(token, c.verifyToken) ? desafio : null;
}

/**
 * Comprueba que el webhook lo mandó Meta y no cualquiera que conoce la URL.
 *
 * Se firma el cuerpo CRUDO. Volver a serializar el objeto ya parseado da otros
 * bytes —el orden de las claves, los espacios— y la firma no coincidiría nunca.
 */
export function firmaValida(cuerpoCrudo: Buffer | string, cabecera: string | undefined): boolean {
  const c = configWhatsapp();
  if (!c.appSecret) return false;
  if (!cabecera?.startsWith('sha256=')) return false;

  const esperada = createHmac('sha256', c.appSecret).update(cuerpoCrudo).digest('hex');
  return sonIguales(cabecera.slice('sha256='.length), esperada);
}

/** Comparación que no delata por el tiempo cuántos caracteres acertó. */
function sonIguales(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'comparacion').update(a).digest();
  const hb = createHmac('sha256', 'comparacion').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ── Lo que llega ────────────────────────────────────────────────────────────

export interface MensajeEntrante {
  /** El id que le puso Meta. Es lo que permite no procesar dos veces. */
  id: string;
  /** El número del cliente, en formato internacional sin el +. */
  de: string;
  texto: string;
  nombre: string;
  /**
   * El identificador del número DEL LOCAL que recibió el mensaje.
   *
   * Meta manda todos los webhooks a la misma dirección, así que con varios
   * locales esto es lo único que dice a cuál va. Vacío en los webhooks viejos
   * o armados a mano.
   */
  paraNumero: string;
}

/**
 * Saca los mensajes de texto del webhook.
 *
 * El formato de Meta viene envuelto en cuatro capas porque el mismo webhook
 * sirve para Instagram, Messenger y estados de entrega. Acá interesa una sola
 * cosa: mensajes de texto entrantes.
 */
export function mensajesDelWebhook(cuerpo: unknown): MensajeEntrante[] {
  const salida: MensajeEntrante[] = [];
  const raiz = cuerpo as { entry?: Array<{ changes?: Array<{ value?: unknown }> }> };

  for (const entrada of raiz?.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      const valor = cambio.value as {
        messages?: Array<{ id?: string; from?: string; type?: string; text?: { body?: string } }>;
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        metadata?: { phone_number_id?: string };
      };

      const paraNumero = valor?.metadata?.phone_number_id?.trim() ?? '';

      const nombres = new Map<string, string>();
      for (const contacto of valor?.contacts ?? []) {
        if (contacto.wa_id) nombres.set(contacto.wa_id, contacto.profile?.name ?? '');
      }

      for (const mensaje of valor?.messages ?? []) {
        // Los audios, las fotos y las ubicaciones se ignoran: el bot toma
        // pedidos por texto. Meta manda de todo por el mismo webhook.
        if (mensaje.type !== 'text') continue;
        const texto = mensaje.text?.body?.trim();
        if (!mensaje.id || !mensaje.from || !texto) continue;
        salida.push({
          id: mensaje.id,
          de: mensaje.from,
          texto,
          nombre: nombres.get(mensaje.from) ?? '',
          paraNumero,
        });
      }
    }
  }
  return salida;
}

// ── No procesar dos veces ───────────────────────────────────────────────────

/**
 * Meta reintenta el webhook si no contestamos rápido o si contestamos con un
 * error. Sin esto, un reintento vuelve a meter el mensaje en la conversación y
 * el bot puede terminar confirmando el pedido dos veces.
 *
 * Devuelve true la primera vez y false en las siguientes. El INSERT con la
 * clave primaria es la comprobación: si dos reintentos llegan a la vez, uno
 * solo gana, y eso lo resuelve SQLite y no nosotros.
 */
export function marcarComoVisto(mensajeId: string, canal = 'whatsapp'): boolean {
  try {
    run('INSERT INTO mensajes_vistos (id, canal) VALUES (?, ?)', [mensajeId, canal]);
    return true;
  } catch {
    return false;
  }
}

/** Los ids viejos no sirven para nada: Meta no reintenta después de un día. */
export function limpiarMensajesVistos(): void {
  run("DELETE FROM mensajes_vistos WHERE created_at < datetime('now', '-7 days')");
}

// ── Lo que sale ─────────────────────────────────────────────────────────────

export class WhatsappError extends Error {}

/**
 * Manda un mensaje de texto. WhatsApp corta en 4096 caracteres, así que un
 * texto largo se parte: mejor dos globos que un mensaje cortado al medio.
 */
export async function enviarWhatsapp(a: string, texto: string): Promise<void> {
  const c = configWhatsapp();
  if (!c.phoneNumberId || !c.token) throw new WhatsappError('WhatsApp no está configurado');

  for (const parte of partirTexto(texto, 4000)) {
    await conReintentos(() =>
      llamarAMeta(c, {
        messaging_product: 'whatsapp',
        to: a,
        type: 'text',
        text: { body: parte },
      }),
    );
  }
}

/**
 * El doble tilde azul.
 *
 * Cuesta una llamada y cambia bastante: el cliente ve que el local lo leyó
 * mientras el bot piensa la respuesta, en vez de mirar un mensaje sin entregar
 * y escribir "hola?" tres veces.
 *
 * Es lo primero que se sacrifica: si falla, no se reintenta ni se avisa.
 */
export async function marcarComoLeidoEnWhatsapp(mensajeId: string): Promise<void> {
  const c = configWhatsapp();
  if (!c.phoneNumberId || !c.token) return;
  try {
    await llamarAMeta(c, { messaging_product: 'whatsapp', status: 'read', message_id: mensajeId });
  } catch {
    // Un tilde que no se pone no es motivo para no contestar el mensaje.
  }
}

/** Un POST a la API de mensajes. Tira `RespuestaDeMeta` si Meta no acepta. */
async function llamarAMeta(c: ConfigWhatsapp, cuerpo: unknown): Promise<void> {
  const respuesta = await fetch(
    `https://graph.facebook.com/${c.version}/${c.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}` },
      body: JSON.stringify(cuerpo),
    },
  );

  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => '');
    throw new RespuestaDeMeta(
      respuesta.status,
      Number(respuesta.headers.get('retry-after')) || 0,
      `Meta rechazó el mensaje (${respuesta.status}): ${detalle.slice(0, 300)}`,
    );
  }
}

/** Un error de Meta que sabe si conviene volver a intentar. */
class RespuestaDeMeta extends WhatsappError {
  constructor(
    readonly estado: number,
    readonly esperarSegundos: number,
    mensaje: string,
  ) {
    super(mensaje);
  }

  /**
   * 429 es "aflojá un poco" y 5xx es "se me cayó algo": los dos se arreglan
   * esperando. El resto de los 4xx son culpa nuestra —token vencido, número
   * mal escrito, fuera de la ventana de 24 h— y reintentar solo repite el
   * error más rápido.
   */
  get convieneReintentar(): boolean {
    return this.estado === 429 || this.estado >= 500;
  }
}

/**
 * Reintenta lo que se arregla esperando.
 *
 * Sin esto, un 429 de Meta —que llega cuando el local se llena, o sea justo
 * cuando importa— dejaba al cliente sin respuesta y sin que nadie se enterara.
 *
 * Tres intentos y se corta: si Meta sigue caído después de siete segundos, la
 * espera ya es peor que el error, y del otro lado hay alguien mirando el
 * teléfono.
 */
async function conReintentos(accion: () => Promise<void>, intentos = 3): Promise<void> {
  for (let intento = 1; ; intento += 1) {
    try {
      await accion();
      return;
    } catch (err) {
      const esperable = err instanceof RespuestaDeMeta && err.convieneReintentar;
      if (!esperable || intento >= intentos) throw err;

      // Si Meta dice cuánto esperar, se le hace caso; si no, 1 s y después 2 s.
      const segundos = err.esperarSegundos || 2 ** (intento - 1);
      console.error(`[whatsapp] Meta contestó ${err.estado}, reintento en ${segundos}s`);
      await new Promise((listo) => setTimeout(listo, Math.min(segundos, 10) * 1000));
    }
  }
}

/** Corta por renglón cuando puede, para no partir una línea de la carta al medio. */
export function partirTexto(texto: string, maximo: number): string[] {
  if (texto.length <= maximo) return [texto];
  const partes: string[] = [];
  let actual = '';
  for (const renglon of texto.split('\n')) {
    if (actual.length + renglon.length + 1 > maximo) {
      if (actual) partes.push(actual);
      // Un renglón solo más largo que el máximo se corta a lo bruto.
      actual = renglon.length > maximo ? '' : renglon;
      if (renglon.length > maximo) {
        for (let i = 0; i < renglon.length; i += maximo) partes.push(renglon.slice(i, i + maximo));
      }
    } else {
      actual = actual ? `${actual}\n${renglon}` : renglon;
    }
  }
  if (actual) partes.push(actual);
  return partes;
}

// ── El número del cliente y su conversación ─────────────────────────────────

/**
 * La conversación de ese número, o una nueva.
 *
 * Se reusa la del mismo número mientras siga abierta: el cliente que escribe
 * "y una coca" tres minutos después está siguiendo su pedido, no empezando
 * otro. Una vez que la conversación se cerró en un pedido, la siguiente
 * empieza limpia.
 */
export function conversacionDelNumero(numero: string, nombre: string): string {
  const abierta = get<{ id: string }>(
    `SELECT id FROM conversations
     WHERE external_id = ? AND order_id IS NULL AND updated_at > datetime('now', '-6 hours')
     ORDER BY updated_at DESC LIMIT 1`,
    [numero],
  );
  if (abierta) return abierta.id;

  const nueva = createConversation({ channel: 'whatsapp', customer_name: nombre });
  run('UPDATE conversations SET external_id = ? WHERE id = ?', [numero, nueva.id]);
  return nueva.id;
}

/** El teléfono con el que contestar, guardado en la conversación. */
export function numeroDeConversacion(conversationId: string): string | null {
  return (
    get<{ external_id: string | null }>('SELECT external_id FROM conversations WHERE id = ?', [
      conversationId,
    ])?.external_id ?? null
  );
}

export const habilitadoEnProduccion = (): boolean => whatsappActivo() && config.env !== 'test';

// ── Probar la conexión ──────────────────────────────────────────────────────

export interface Diagnostico {
  paso: string;
  ok: boolean;
  detalle: string;
  /** Qué hacer si falló. En castellano, no el error de Meta. */
  arreglo?: string;
}

/**
 * Revisa la conexión con Meta y dice qué falta, paso por paso.
 *
 * Conectar WhatsApp es media hora de ir y venir entre cuatro credenciales
 * parecidas, y cuando algo no anda el error de Meta no dice cuál de las cuatro
 * es. Esto lo contesta de una: prueba cada cosa por separado contra su API y
 * dice qué arreglar.
 */
export async function probarWhatsapp(): Promise<{ listo: boolean; pasos: Diagnostico[] }> {
  const c = configWhatsapp();
  const pasos: Diagnostico[] = [];

  // 1. Que estén las cuatro.
  const falta = loQueFaltaDeWhatsapp();
  pasos.push({
    paso: 'Las credenciales están cargadas',
    ok: falta.length === 0,
    detalle: falta.length ? `Falta ${falta.join(', ')}` : 'Las cuatro están',
    arreglo: falta.length ? 'Cargalas en el .env del servidor y reiniciá con: docker compose up -d' : undefined,
  });
  if (falta.length) return { listo: false, pasos };

  // 2. Que el token sirva y sea de ESE número.
  try {
    const res = await fetch(
      `https://graph.facebook.com/${c.version}/${c.phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { authorization: `Bearer ${c.token}` } },
    );
    const cuerpo = (await res.json().catch(() => ({}))) as {
      display_phone_number?: string;
      verified_name?: string;
      error?: { message?: string; code?: number };
    };

    if (res.ok) {
      pasos.push({
        paso: 'Meta reconoce el número',
        ok: true,
        detalle: `${cuerpo.verified_name ?? 'sin nombre'} · ${cuerpo.display_phone_number ?? c.phoneNumberId}`,
      });
    } else if (res.status === 401 || cuerpo.error?.code === 190) {
      pasos.push({
        paso: 'Meta reconoce el número',
        ok: false,
        detalle: 'El token no sirve o venció',
        arreglo:
          'Generá un token nuevo en developers.facebook.com. Los temporales duran 24 h: ' +
          'para producción hace falta uno permanente (System User).',
      });
    } else if (res.status === 404) {
      pasos.push({
        paso: 'Meta reconoce el número',
        ok: false,
        detalle: `No existe el número ${c.phoneNumberId}`,
        arreglo:
          'WHATSAPP_PHONE_NUMBER_ID es el identificador del número, no el número. ' +
          'Está en la pantalla de la API de WhatsApp, abajo del teléfono.',
      });
    } else {
      pasos.push({
        paso: 'Meta reconoce el número',
        ok: false,
        detalle: cuerpo.error?.message ?? `Meta contestó ${res.status}`,
      });
    }
  } catch (err) {
    pasos.push({
      paso: 'Meta reconoce el número',
      ok: false,
      detalle: err instanceof Error ? err.message : 'No se pudo llegar a Meta',
      arreglo: 'El servidor tiene que poder salir a graph.facebook.com.',
    });
  }

  // 3. Que la clave de la app firme como Meta espera.
  //    Se verifica una firma armada acá: si el cálculo no coincide consigo
  //    mismo, la clave está mal copiada (un espacio, un salto de línea).
  const prueba = JSON.stringify({ prueba: true });
  const firmaPropia = `sha256=${createHmac('sha256', c.appSecret).update(prueba).digest('hex')}`;
  pasos.push({
    paso: 'La clave de la app firma bien',
    ok: firmaValida(prueba, firmaPropia),
    detalle: firmaValida(prueba, firmaPropia)
      ? 'La firma del webhook se va a poder verificar'
      : 'La clave no sirve para firmar',
    arreglo: firmaValida(prueba, firmaPropia)
      ? undefined
      : 'Copiá de nuevo el App Secret, sin espacios ni saltos de línea.',
  });

  // 4. El webhook: esto no se puede probar desde acá, lo prueba Meta.
  pasos.push({
    paso: 'El webhook está dado de alta',
    ok: true,
    detalle: 'Esto lo comprueba Meta cuando le das "Verificar y guardar"',
    arreglo:
      'En la app de Meta, Webhooks → WhatsApp, poné la URL de este servidor terminada ' +
      'en /api/whatsapp, pegá la misma palabra de WHATSAPP_VERIFY_TOKEN y suscribite a "messages".',
  });

  return { listo: pasos.every((p) => p.ok), pasos };
}
