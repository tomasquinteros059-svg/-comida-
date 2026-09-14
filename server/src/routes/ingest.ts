import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { applyImport, planImport } from '../domain/ingest.js';
import { aTextoDeTabla } from '../domain/planillas.js';

export const ingestRouter = Router();

const body = z.object({
  // El navegador lee el archivo y manda el contenido: evita una dependencia de
  // multipart para lo unico que se sube aca, que son planillas y notas. Los
  // binarios (Excel, PDF) vienen en base64.
  content: z.string().min(1, 'El archivo está vacío').max(3_500_000, 'El archivo es muy grande (máximo 2,5 MB)'),
  filename: z.string().optional(),
  kind: z.enum(['carta', 'insumos', 'conocimiento']).optional(),
  base64: z.boolean().optional(),
});

/**
 * Un Excel o un PDF se convierten primero al texto delimitado que ya sabe leer
 * la ingesta. De ahi en adelante el camino es el mismo, venga de donde venga.
 */
async function normalizar(crudo: unknown) {
  const input = body.parse(crudo);
  const lectura = await aTextoDeTabla(input);
  return {
    input: { content: lectura.texto, filename: input.filename, kind: input.kind },
    lectura,
  };
}

/** Calcula que cambiaria el archivo, sin tocar nada. */
ingestRouter.post(
  '/preview',
  route(async (req) => {
    const { input, lectura } = await normalizar(req.body);
    const plan = planImport(input);
    // Los avisos de la lectura van con los del plan: si el Excel tenia cuatro
    // hojas, eso importa tanto como una fila mal formada.
    return { ...plan, origen: lectura.origen, issues: [...lectura.avisos, ...plan.issues] };
  }),
);

/** Aplica el archivo. Recalcula el plan del contenido, no confia en el cliente. */
ingestRouter.post(
  '/apply',
  route(async (req) => {
    const { input, lectura } = await normalizar(req.body);
    const resultado = applyImport(input);
    return { ...resultado, origen: lectura.origen, issues: [...lectura.avisos, ...resultado.issues] };
  }),
);
