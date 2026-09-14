import { z } from 'zod';
import { all, get } from '../db/index.js';

/**
 * Paginación de los listados.
 *
 * Antes cada listado traía "las últimas 100 y nada más": con 45 días cargados
 * no se notaba, pero al año "ver las órdenes de compra de marzo" no se podía.
 * El corte seguía existiendo, solo que en silencio y sin forma de pasar de él.
 *
 * Se usa desplazamiento (`desde`) y no un cursor porque el panel muestra
 * páginas numeradas de cosas que el local mira hacia atrás, no un scroll
 * infinito, y con un índice por fecha SQLite resuelve esto de sobra para el
 * tamaño de un local.
 */
export interface Pagina<T> {
  items: T[];
  /** Cuántas hay en total, no cuántas vinieron. Es lo que deja paginar. */
  total: number;
  desde: number;
  limite: number;
  hay_mas: boolean;
}

export interface OpcionesDePagina {
  limite: number;
  desde: number;
}

/** Los parámetros tal como llegan por query string. */
export const paginaSchema = z.object({
  limite: z.coerce.number().int().min(1).max(500).default(50),
  desde: z.coerce.number().int().min(0).default(0),
});

export const leerPagina = (query: unknown): OpcionesDePagina =>
  paginaSchema.parse(query ?? {});

/**
 * Corre la consulta de la página y la del total en una sola llamada.
 *
 * `desde` y `limite` se interpolan como números ya validados por zod y no como
 * parámetros, porque van al final de la consulta y así el mismo `select` sirve
 * para contar cambiándole solo la proyección.
 */
export function consultarPagina<T>(
  select: string,
  desdeSql: string,
  params: unknown[],
  opciones: OpcionesDePagina,
): Pagina<T> {
  const total = get<{ n: number }>(`SELECT COUNT(*) AS n ${desdeSql}`, params)?.n ?? 0;
  const items = all<T>(
    `SELECT ${select} ${desdeSql} LIMIT ${opciones.limite} OFFSET ${opciones.desde}`,
    params,
  );
  return {
    items,
    total,
    desde: opciones.desde,
    limite: opciones.limite,
    hay_mas: opciones.desde + items.length < total,
  };
}

/** Arma una página con filas que ya se trajeron de otra forma. */
export const armarPagina = <T>(items: T[], total: number, o: OpcionesDePagina): Pagina<T> => ({
  items,
  total,
  desde: o.desde,
  limite: o.limite,
  hay_mas: o.desde + items.length < total,
});
