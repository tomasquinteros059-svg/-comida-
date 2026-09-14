import { getSetting, run, get, setSetting } from '../db/index.js';

/**
 * Cuánto tiempo se guardan las conversaciones del chat.
 *
 * Los mensajes traen lo que la gente escribió: nombres, teléfonos,
 * direcciones. Guardados para siempre, el local termina con una base de datos
 * de clientes que nadie decidió tener y que alguien le va a pedir cuenta
 * alguna vez.
 *
 * El borrado es de las CONVERSACIONES, no de los pedidos: las ventas son la
 * contabilidad del local y esas se guardan. Lo que se va es la charla.
 */

export const CLAVE_RETENCION = 'retencion_conversaciones_dias';

/** Tres meses: alcanza para revisar el bot y no es un archivo histórico. */
export const DIAS_POR_DEFECTO = 90;

/** 0 significa "no borrar nunca", y es una decisión explícita del local. */
export function diasDeRetencion(): number {
  const guardado = Number(getSetting(CLAVE_RETENCION, String(DIAS_POR_DEFECTO)));
  if (!Number.isFinite(guardado) || guardado < 0) return DIAS_POR_DEFECTO;
  return Math.floor(guardado);
}

export function fijarDiasDeRetencion(dias: number): void {
  if (!Number.isFinite(dias) || dias < 0 || dias > 3650) {
    throw new Error('Los días de retención van de 0 (no borrar) a 3650');
  }
  setSetting(CLAVE_RETENCION, String(Math.floor(dias)));
}

export interface Purga {
  conversaciones: number;
  mensajes: number;
  dias: number;
}

/**
 * Borra las conversaciones más viejas que el plazo configurado.
 *
 * Nunca toca una conversación que terminó en pedido: ahí el vínculo entre la
 * venta y lo que se pidió es parte de la operación del local, no una charla
 * suelta.
 */
export function purgarConversacionesViejas(): Purga {
  const dias = diasDeRetencion();
  if (dias === 0) return { conversaciones: 0, mensajes: 0, dias };

  const corte = `-${dias} days`;
  const condicion = `updated_at < datetime('now', ?) AND order_id IS NULL`;

  const cuantas =
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversations WHERE ${condicion}`, [corte])?.n ?? 0;
  if (!cuantas) return { conversaciones: 0, mensajes: 0, dias };

  const mensajes =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages
       WHERE conversation_id IN (SELECT id FROM conversations WHERE ${condicion})`,
      [corte],
    )?.n ?? 0;

  run(
    `DELETE FROM messages
     WHERE conversation_id IN (SELECT id FROM conversations WHERE ${condicion})`,
    [corte],
  );
  run(`DELETE FROM conversations WHERE ${condicion}`, [corte]);

  return { conversaciones: cuantas, mensajes, dias };
}

/** Qué hay hoy guardado, para que el local sepa de qué está hablando. */
export function estadoDeRetencion() {
  const dias = diasDeRetencion();
  const total = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')?.n ?? 0;
  const conPedido =
    get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE order_id IS NOT NULL')?.n ?? 0;
  const mensajes = get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n ?? 0;
  const laMasVieja =
    get<{ f: string }>('SELECT MIN(created_at) AS f FROM conversations')?.f ?? null;

  const aBorrar =
    dias === 0
      ? 0
      : get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM conversations
           WHERE updated_at < datetime('now', ?) AND order_id IS NULL`,
          [`-${dias} days`],
        )?.n ?? 0;

  return { dias, total, con_pedido: conPedido, mensajes, la_mas_vieja: laMasVieja, a_borrar: aBorrar };
}
