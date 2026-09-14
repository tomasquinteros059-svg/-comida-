import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} no encontrado`);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Envuelve un handler async: manda el valor devuelto como JSON y encamina errores. */
export const route =
  (handler: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await handler(req, res);
      if (res.headersSent) return;
      res.json(result ?? { ok: true });
    } catch (err) {
      next(err);
    }
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Datos inválidos',
      issues: err.issues.map((i) => ({ campo: i.path.join('.'), detalle: i.message })),
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
  }

  // Un cuerpo mal formado es culpa de quien lo mando, no del servidor, y
  // devolver 500 invita a insistir.
  if (isBodyParseError(err)) {
    return res.status(400).json({ error: 'El contenido enviado no es válido' });
  }

  console.error('[error]', err);

  // En produccion el mensaje interno no sale: un error de SQLite trae la
  // consulta y la ruta del archivo, que es justo lo que no queremos regalar.
  const message =
    config.env === 'production'
      ? 'Error interno'
      : err instanceof Error
        ? err.message
        : 'Error interno';
  return res.status(500).json({ error: message });
}

/** Errores que tira body-parser cuando el JSON viene roto o es muy grande. */
function isBodyParseError(err: unknown): boolean {
  const candidate = err as { type?: string; status?: number };
  return (
    typeof candidate?.type === 'string' &&
    ['entity.parse.failed', 'entity.too.large', 'encoding.unsupported', 'request.aborted'].includes(
      candidate.type,
    )
  );
}
