import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './http.js';

/**
 * Limite de pedidos por ventana, en memoria.
 *
 * El chat es publico y cada turno puede costar plata (una llamada al modelo).
 * Sin esto, cualquiera con un bucle vacia el presupuesto del local en una
 * tarde. Es un contador por proceso, igual que el bus de eventos: si algun dia
 * hay varias instancias, se cambia por Redis y las rutas no se tocan.
 */
export interface RateLimitOptions {
  /** Ventana en milisegundos. */
  windowMs: number;
  /** Pedidos permitidos por ventana. */
  max: number;
  /** Como se identifica a quien pide. Por defecto, la IP. */
  key?: (req: Request) => string;
  message?: string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  // Limpieza perezosa: se barre cuando el mapa crece, no con un timer que
  // mantendria el proceso despierto.
  const sweep = (now: number) => {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  };

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (buckets.size > 5_000) sweep(now);

    const key = options.key?.(req) ?? req.ip ?? 'desconocido';
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      const seconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(seconds));
      return next(
        new HttpError(429, options.message ?? `Demasiados pedidos. Probá de nuevo en ${seconds} segundos.`),
      );
    }
    return next();
  };
}
