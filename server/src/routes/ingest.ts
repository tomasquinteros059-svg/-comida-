import { Router } from 'express';
import { z } from 'zod';
import { route } from '../lib/http.js';
import { applyImport, planImport } from '../domain/ingest.js';

export const ingestRouter = Router();

const body = z.object({
  // El navegador lee el archivo y manda el texto: evita una dependencia de
  // multipart para lo unico que se sube aca, que son planillas y notas.
  content: z.string().min(1, 'El archivo está vacío').max(2_000_000, 'El archivo es muy grande (máximo 2 MB)'),
  filename: z.string().optional(),
  kind: z.enum(['carta', 'insumos', 'conocimiento']).optional(),
});

/** Calcula que cambiaria el archivo, sin tocar nada. */
ingestRouter.post('/preview', route((req) => planImport(body.parse(req.body))));

/** Aplica el archivo. Recalcula el plan del contenido, no confia en el cliente. */
ingestRouter.post('/apply', route((req) => applyImport(body.parse(req.body))));
