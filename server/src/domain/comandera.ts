import net from 'node:net';
import { getOrderOrThrow, kitchenTicket } from './orders.js';
import { getSetting, setSetting } from '../db/index.js';

/**
 * Impresión directa en la comandera de la cocina.
 *
 * Hasta ahora la comanda se generaba y se imprimía desde el navegador: alguien
 * tenía que estar mirando la pantalla y apretar. En una cocina con las manos
 * ocupadas eso no pasa, y el pedido se pierde entre dos que sí se imprimieron.
 *
 * Las comanderas térmicas hablan ESC/POS —un protocolo de los años ochenta que
 * siguen usando todas— por el puerto 9100 si son de red. Se les manda texto
 * plano con unos pocos comandos de control intercalados y listo: no hay driver,
 * no hay descubrimiento, no hay nada que instalar en el servidor.
 */

// ── Comandos ESC/POS ────────────────────────────────────────────────────────
// Son secuencias de bytes, no texto. Van con nombre para que se entienda qué
// hace cada una cuando alguien lea esto dentro de dos años.

const ESC = 0x1b;
const GS = 0x1d;

const CMD = {
  /** Vuelve la impresora a su estado de fábrica. Siempre va primero. */
  inicializar: Buffer.from([ESC, 0x40]),
  /** Doble alto y doble ancho: el número de pedido tiene que leerse de lejos. */
  grande: Buffer.from([GS, 0x21, 0x11]),
  normal: Buffer.from([GS, 0x21, 0x00]),
  negrita: Buffer.from([ESC, 0x45, 0x01]),
  sinNegrita: Buffer.from([ESC, 0x45, 0x00]),
  centrado: Buffer.from([ESC, 0x61, 0x01]),
  izquierda: Buffer.from([ESC, 0x61, 0x00]),
  /** Avanza el papel y corta. El 66 es cuánto avanza antes del corte. */
  cortar: Buffer.from([GS, 0x56, 0x42, 0x42]),
  /** Abre el cajón del dinero, si hay uno enchufado a la comandera. */
  abrirCajon: Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]),
};

/**
 * Las comanderas viejas no entienden UTF-8: usan una tabla de caracteres de
 * un byte. En vez de pelear con cuál trae cada modelo, se sacan los acentos.
 * "Milanesa napolitana" se lee igual; "Milanesa napolitana" con la ñ rota, no.
 */
export function aTextoDeComandera(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ñ/g, 'n')
    .replace(/Ñ/g, 'N')
    .replace(/[^\x20-\x7e\n]/g, ' ');
}

export interface OpcionesDeImpresion {
  /** Cuántas copias. Algunas cocinas quieren una para la plancha y otra para el pase. */
  copias?: number;
  /** Abrir el cajón del dinero al imprimir. Solo tiene sentido en el mostrador. */
  abrirCajon?: boolean;
}

/**
 * Arma los bytes de una comanda. Se separa del envío a propósito: así se puede
 * probar lo que sale sin necesitar una impresora.
 */
export function comandaEnBytes(orderId: string, opciones: OpcionesDeImpresion = {}): Buffer {
  const order = getOrderOrThrow(orderId);
  const numero = String(order.daily_number).padStart(3, '0');
  const partes: Buffer[] = [CMD.inicializar];

  // El número, grande y centrado: es lo único que se mira de lejos.
  partes.push(CMD.centrado, CMD.grande, CMD.negrita);
  partes.push(Buffer.from(aTextoDeComandera(`#${numero}\n`), 'latin1'));
  partes.push(CMD.normal, CMD.sinNegrita);

  // El resto es la misma comanda que ya se imprimía desde el navegador, para
  // que no haya dos formatos distintos dando vueltas.
  partes.push(CMD.izquierda);
  const cuerpo = kitchenTicket(orderId)
    .split('\n')
    .slice(1) // la primera línea es el número, que ya fue en grande
    .join('\n');
  partes.push(Buffer.from(aTextoDeComandera(`${cuerpo}\n`), 'latin1'));

  if (opciones.abrirCajon) partes.push(CMD.abrirCajon);
  partes.push(CMD.cortar);

  const una = Buffer.concat(partes);
  const copias = Math.max(1, Math.min(opciones.copias ?? 1, 5));
  return copias === 1 ? una : Buffer.concat(Array.from({ length: copias }, () => una));
}

// ── Configuración ───────────────────────────────────────────────────────────

export const CLAVE_HOST = 'comandera_host';
export const CLAVE_PUERTO = 'comandera_puerto';
export const CLAVE_AUTO = 'comandera_automatica';
export const CLAVE_COPIAS = 'comandera_copias';

export interface ConfigComandera {
  host: string;
  puerto: number;
  /** Imprimir sola cuando entra un pedido, sin que nadie apriete nada. */
  automatica: boolean;
  copias: number;
}

export function configDeComandera(): ConfigComandera {
  const puerto = Number(getSetting(CLAVE_PUERTO, '9100'));
  const copias = Number(getSetting(CLAVE_COPIAS, '1'));
  return {
    host: getSetting(CLAVE_HOST, ''),
    puerto: Number.isFinite(puerto) && puerto > 0 ? puerto : 9100,
    automatica: getSetting(CLAVE_AUTO, '0') === '1',
    copias: Number.isFinite(copias) && copias >= 1 ? Math.min(copias, 5) : 1,
  };
}

export function fijarComandera(cambio: Partial<ConfigComandera>): ConfigComandera {
  if (cambio.host !== undefined) setSetting(CLAVE_HOST, cambio.host.trim());
  if (cambio.puerto !== undefined) setSetting(CLAVE_PUERTO, String(cambio.puerto));
  if (cambio.automatica !== undefined) setSetting(CLAVE_AUTO, cambio.automatica ? '1' : '0');
  if (cambio.copias !== undefined) setSetting(CLAVE_COPIAS, String(cambio.copias));
  return configDeComandera();
}

export const hayComandera = (): boolean => configDeComandera().host.length > 0;

// ── Envío ───────────────────────────────────────────────────────────────────

export class ComanderaError extends Error {}

/**
 * Manda los bytes por TCP. Con timeout corto: si la comandera está apagada o
 * alguien la desenchufó, la cocina tiene que enterarse ahora y no cuando el
 * pedido ya salió.
 */
export function enviarBytes(
  datos: Buffer,
  destino: { host: string; puerto: number },
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolver, rechazar) => {
    const socket = new net.Socket();
    let listo = false;

    const terminar = (err?: Error) => {
      if (listo) return;
      listo = true;
      socket.destroy();
      err ? rechazar(err) : resolver();
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () =>
      terminar(new ComanderaError(`La comandera de ${destino.host} no contestó en ${timeoutMs / 1000} s`)),
    );
    socket.on('error', (err) =>
      terminar(new ComanderaError(`No se pudo hablar con la comandera: ${err.message}`)),
    );

    socket.connect(destino.puerto, destino.host, () => {
      socket.write(datos, () => socket.end());
    });
    // `end` espera a que el otro lado cierre; `close` llega siempre.
    socket.on('close', () => terminar());
  });
}

export interface ResultadoDeImpresion {
  impreso: boolean;
  motivo?: string;
  bytes?: number;
}

/** Imprime una comanda. Nunca tira: el pedido vale más que la impresión. */
export async function imprimirComanda(
  orderId: string,
  opciones: OpcionesDeImpresion = {},
): Promise<ResultadoDeImpresion> {
  const config = configDeComandera();
  if (!config.host) return { impreso: false, motivo: 'No hay comandera configurada' };

  const datos = comandaEnBytes(orderId, { copias: config.copias, ...opciones });
  try {
    await enviarBytes(datos, { host: config.host, puerto: config.puerto });
    return { impreso: true, bytes: datos.length };
  } catch (err) {
    return { impreso: false, motivo: err instanceof Error ? err.message : 'Error desconocido' };
  }
}
