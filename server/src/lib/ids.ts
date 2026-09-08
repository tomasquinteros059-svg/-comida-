import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

/**
 * Id ordenable por tiempo, tipo ULID: 10 chars de timestamp + 12 aleatorios.
 * Ordenar por id equivale a ordenar por fecha de creacion.
 */
export function newId(prefix = ''): string {
  let ts = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  const bytes = randomBytes(12);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return prefix ? `${prefix}_${time}${rand}` : time + rand;
}

/** Codigo corto y legible para pedidos/compras: PED-7Q4K9M */
export function shortCode(prefix: string): string {
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return `${prefix}-${out}`;
}
