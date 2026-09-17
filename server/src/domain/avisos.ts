import { getSetting, setSetting, get, run } from '../db/index.js';
import { badRequest } from '../lib/http.js';
import type { OrderStatus } from './types.js';

/**
 * Avisarle al cliente por WhatsApp cómo va su pedido.
 *
 * Hasta acá el bot tomaba el pedido y se callaba. El cliente se quedaba
 * mirando el teléfono sin saber si lo habían leído, y a los diez minutos
 * llamaba al local para preguntar —que es exactamente el teléfono que el bot
 * venía a sacarse de encima—.
 *
 * Se avisa en tres momentos y no en cada cambio de estado:
 *
 *   confirmado  el local lo tomó, y cuánto va a tardar
 *   listo       ya lo puede pasar a buscar, o ya salió el reparto
 *   cancelado   con el motivo, que es lo único peor que no avisar
 *
 * "En preparación" no se avisa a propósito: no le cambia nada al que espera y
 * son globos de más en su teléfono. "Entregado" tampoco: lo tiene en la mano.
 *
 * Nada de esto puede voltear un cambio de estado. Si WhatsApp no anda, el
 * pedido igual pasa a listo y la cocina sigue trabajando: el aviso es lo
 * primero que se sacrifica, no lo último.
 */

const CLAVE_ACTIVO = 'avisos.whatsapp.activo';
const CLAVE_DEMORA = 'avisos.whatsapp.demora_min';

export interface ConfigAvisos {
  /** Si se le avisa al cliente por WhatsApp. */
  activo: boolean;
  /** Demora que se promete al confirmar, en minutos. 0 = no prometer nada. */
  demoraMin: number;
}

export function configDeAvisos(): ConfigAvisos {
  const demora = Number(getSetting(CLAVE_DEMORA, '30'));
  return {
    // Prendido por omisión: es lo que el cliente espera de cualquier local que
    // atiende por WhatsApp, y apagarlo es la excepción.
    activo: getSetting(CLAVE_ACTIVO, '1') === '1',
    demoraMin: Number.isFinite(demora) && demora >= 0 ? demora : 30,
  };
}

export function guardarConfigDeAvisos(input: Partial<ConfigAvisos>): ConfigAvisos {
  if (input.activo !== undefined) setSetting(CLAVE_ACTIVO, input.activo ? '1' : '0');
  if (input.demoraMin !== undefined) {
    const n = Number(input.demoraMin);
    if (!Number.isFinite(n) || n < 0 || n > 240) {
      throw badRequest('La demora tiene que estar entre 0 y 240 minutos');
    }
    setSetting(CLAVE_DEMORA, String(Math.round(n)));
  }
  return configDeAvisos();
}

/** El teléfono al que avisarle, si el pedido entró por WhatsApp. */
export function telefonoDelPedido(orderId: string): string | null {
  const fila = get<{ external_id: string | null; channel: string }>(
    'SELECT external_id, channel FROM conversations WHERE order_id = ? ORDER BY updated_at DESC LIMIT 1',
    [orderId],
  );
  if (!fila || fila.channel !== 'whatsapp') return null;
  return fila.external_id || null;
}

/**
 * El texto de cada aviso.
 *
 * Se escriben como los escribiría el del mostrador: corto, sin "estimado
 * cliente" y sin el número interno del pedido, que al cliente no le dice nada.
 * El código sí va, porque es el que se canta cuando lo viene a buscar.
 */
export function textoDelAviso(
  estado: OrderStatus,
  datos: { codigo: string; servicio: string; demoraMin: number; motivo?: string },
): string | null {
  const esDelivery = datos.servicio === 'delivery';

  switch (estado) {
    case 'confirmado': {
      const demora = datos.demoraMin
        ? ` Calculá unos ${datos.demoraMin} minutos.`
        : '';
      return `Listo, tomamos tu pedido ${datos.codigo}.${demora}`;
    }
    case 'listo':
      return esDelivery
        ? `Tu pedido ${datos.codigo} ya salió para allá.`
        : `Tu pedido ${datos.codigo} ya está listo, cuando quieras lo pasás a buscar.`;
    case 'cancelado':
      return datos.motivo
        ? `Tuvimos que cancelar tu pedido ${datos.codigo}: ${datos.motivo}. Perdoná.`
        : `Tuvimos que cancelar tu pedido ${datos.codigo}. Perdoná las molestias.`;
    default:
      // En preparación y entregado no se avisan: ver el comentario de arriba.
      return null;
  }
}

/**
 * Que el mismo aviso no salga dos veces.
 *
 * Un pedido puede volver a "listo" si alguien se equivocó y lo movió de ida y
 * de vuelta. El cliente no tiene por qué recibir dos veces "ya está listo": la
 * segunda lo hace venir al mostrador a preguntar si hay dos pedidos.
 *
 * El INSERT con la clave primaria es la comprobación, igual que con los
 * mensajes de Meta: si dos cambios entran a la vez, uno solo gana.
 */
export function marcarAvisoMandado(orderId: string, estado: string): boolean {
  try {
    run('INSERT INTO avisos_mandados (order_id, estado) VALUES (?, ?)', [orderId, estado]);
    return true;
  } catch {
    return false;
  }
}

export interface ResultadoDeAviso {
  mandado: boolean;
  /** Por qué no se mandó. Vacío cuando se mandó. */
  motivo?: string;
}

/**
 * Le avisa al cliente, si corresponde. Nunca tira.
 *
 * Se llama desde `advanceOrder` y de ahí no puede salir nada que voltee el
 * cambio de estado: la cocina no se frena porque Meta esté caído.
 *
 * El ORDEN de los avisos de un mismo pedido lo pone quien llama, con `enFila`
 * (ver `avisarAlCliente` en orders.ts). Acá no se encola a propósito: dos
 * colas anidadas con la misma clave se traban solas.
 */
export async function avisarCambioDeEstado(
  orderId: string,
  estado: OrderStatus,
  opts: { motivo?: string } = {},
): Promise<ResultadoDeAviso> {
  try {
    const config = configDeAvisos();
    if (!config.activo) return { mandado: false, motivo: 'los avisos están apagados' };

    const telefono = telefonoDelPedido(orderId);
    if (!telefono) return { mandado: false, motivo: 'el pedido no entró por WhatsApp' };

    const pedido = get<{ code: string; service_type: string }>(
      'SELECT code, service_type FROM orders WHERE id = ?',
      [orderId],
    );
    if (!pedido) return { mandado: false, motivo: 'no existe el pedido' };

    const texto = textoDelAviso(estado, {
      codigo: pedido.code,
      servicio: pedido.service_type,
      demoraMin: config.demoraMin,
      motivo: opts.motivo,
    });
    if (!texto) return { mandado: false, motivo: 'ese estado no se avisa' };

    // Primero si se puede mandar, DESPUÉS marcarlo. Al revés, un local que
    // todavía no conectó WhatsApp quemaría todos los avisos: quedarían
    // marcados como mandados sin haber salido, y no los recibiría nunca, ni
    // después de conectar.
    const { enviarWhatsapp, habilitadoEnProduccion } = await import('./whatsapp.js');
    if (!habilitadoEnProduccion()) {
      return { mandado: false, motivo: 'WhatsApp no está configurado' };
    }

    // Marcar antes de mandar, igual que con los mensajes entrantes: si dos
    // cambios llegan juntos, uno solo escribe y uno solo manda.
    if (!marcarAvisoMandado(orderId, estado)) {
      return { mandado: false, motivo: 'ya se había avisado' };
    }

    // Si esto falla, la marca queda puesta y el aviso no se reintenta. Es a
    // propósito: `enviarWhatsapp` ya reintenta solo cuando Meta se cae un
    // rato, así que llegar acá es una caída larga, y un segundo "ya está
    // listo" media hora después manda al cliente al mostrador a preguntar si
    // hay dos pedidos.
    await enviarWhatsapp(telefono, texto);
    return { mandado: true };
  } catch (err) {
    // Un aviso que no sale es una molestia; un pedido que no avanza es el
    // local parado. Se registra y se sigue.
    console.error(`[avisos] no pude avisar ${estado} de ${orderId}:`, err);
    return { mandado: false, motivo: err instanceof Error ? err.message : 'error inesperado' };
  }
}
