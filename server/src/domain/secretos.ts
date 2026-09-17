import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { getSetting, setSetting } from '../db/index.js';
import { config } from '../config.js';

/**
 * Credenciales guardadas en la base, pero cifradas.
 *
 * El problema que resuelve: hasta acá las credenciales de WhatsApp iban SOLO
 * por variables de entorno. Eso está bien para el que administra el servidor y
 * es una pared para el dueño del local, que no tiene SSH ni por qué tenerlo:
 * "conectá WhatsApp" terminaba siendo "conseguite a alguien que edite un
 * archivo en el servidor".
 *
 * La razón para dejarlas afuera de la base sigue siendo buena: la base se
 * respalda todas las noches y esas copias terminan circulando —en un pendrive,
 * en un mail, en la nube de alguien—. Un token adentro de una copia que anda
 * dando vueltas deja mandar mensajes en nombre del local.
 *
 * Por eso se guardan cifradas con una clave que NO está en la base. Una copia
 * robada trae los mensajes cifrados y nada más: sin el archivo del servidor no
 * se abren.
 *
 * La clave sale de ADMIN_TOKEN, que ya es obligatorio en producción. Eso tiene
 * una consecuencia que conviene saber: si se cambia el ADMIN_TOKEN, lo que
 * estaba guardado deja de poder leerse y hay que cargarlo de nuevo. Es un
 * minuto de trabajo y pasa una vez cada muchos años; pedir otra variable
 * obligatoria más, en cambio, es una instalación que no arranca.
 */

/** Cómo quedó guardado, para poder cambiar el método más adelante sin romper. */
const VERSION = 'v1';

/**
 * La clave de cifrado, derivada del ADMIN_TOKEN.
 *
 * scrypt y no el token pelado: el token es una cadena elegida por una persona,
 * y las claves de AES son 32 bytes. Derivarla también hace que el token no
 * quede escrito tal cual en ningún lado.
 */
function claveDeCifrado(): Buffer | null {
  const base = config.adminToken;
  // Sin ADMIN_TOKEN no hay dónde anclar la clave. Pasa solo en desarrollo:
  // en producción el proceso ni arranca sin él.
  if (!base) return null;
  return scryptSync(base, 'comeia-secretos-v1', 32);
}

/** true cuando se puede guardar algo cifrado. */
export const sePuedeGuardar = (): boolean => claveDeCifrado() !== null;

/**
 * Cifra un valor. El resultado es texto y se puede guardar en cualquier lado.
 *
 * Formato: v1:<nonce>:<etiqueta>:<cifrado>, todo en base64. GCM y no CBC
 * porque además de esconder el valor detecta si alguien lo tocó: una
 * credencial editada a mano en la base tiene que fallar al leerse, no
 * devolver basura.
 */
export function cifrar(valor: string): string {
  const clave = claveDeCifrado();
  if (!clave) throw new Error('No hay ADMIN_TOKEN: no se puede guardar una credencial cifrada');

  const nonce = randomBytes(12);
  const cifrador = createCipheriv('aes-256-gcm', clave, nonce);
  const cifrado = Buffer.concat([cifrador.update(valor, 'utf8'), cifrador.final()]);
  const etiqueta = cifrador.getAuthTag();

  return [VERSION, nonce.toString('base64'), etiqueta.toString('base64'), cifrado.toString('base64')].join(':');
}

/**
 * Descifra. Devuelve cadena vacía si no se puede, en vez de tirar.
 *
 * El caso que importa: alguien cambió el ADMIN_TOKEN. Ahí lo correcto es que
 * WhatsApp aparezca como "no configurado" y el panel pida cargarlo de nuevo,
 * no que el servidor deje de arrancar.
 */
export function descifrar(guardado: string): string {
  if (!guardado) return '';
  const clave = claveDeCifrado();
  if (!clave) return '';

  const partes = guardado.split(':');
  if (partes.length !== 4 || partes[0] !== VERSION) return '';

  try {
    const descifrador = createDecipheriv('aes-256-gcm', clave, Buffer.from(partes[1]!, 'base64'));
    descifrador.setAuthTag(Buffer.from(partes[2]!, 'base64'));
    return Buffer.concat([
      descifrador.update(Buffer.from(partes[3]!, 'base64')),
      descifrador.final(),
    ]).toString('utf8');
  } catch {
    // Etiqueta que no coincide: o cambió el ADMIN_TOKEN, o alguien editó la
    // fila a mano. En los dos casos el valor no sirve.
    return '';
  }
}

const clave = (nombre: string) => `secreto.${nombre}`;

/** Guarda una credencial. Vacío la borra. */
export function guardarSecreto(nombre: string, valor: string): void {
  const limpio = valor.trim();
  setSetting(clave(nombre), limpio ? cifrar(limpio) : '');
}

/** Lee una credencial. Cadena vacía si no está o no se puede abrir. */
export function leerSecreto(nombre: string): string {
  return descifrar(getSetting(clave(nombre), ''));
}

/** true si hay algo guardado, sin abrirlo. Para saber si hace falta pedirlo. */
export const hayGuardado = (nombre: string): boolean => Boolean(getSetting(clave(nombre), ''));
