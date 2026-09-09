import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Raiz del proyecto (la carpeta que contiene server/ y web/). Las rutas
 * relativas se resuelven contra esto y no contra process.cwd(), asi el
 * servidor y los scripts npm apuntan siempre a la misma base de datos.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const resolveFromRoot = (p: string) => (path.isAbsolute(p) ? p : path.resolve(projectRoot, p));

export const config = {
  port: Number(process.env.PORT ?? 3000),
  env: process.env.NODE_ENV ?? 'development',
  projectRoot,
  databasePath: resolveFromRoot(process.env.DATABASE_PATH ?? './data/comeia.db'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || '',
  chatModel: process.env.CHAT_MODEL?.trim() || 'claude-sonnet-5',
  adminToken: process.env.ADMIN_TOKEN?.trim() || '',
  currency: process.env.CURRENCY ?? 'ARS',
  timezone: process.env.TIMEZONE ?? 'America/Argentina/Buenos_Aires',
};

/** Si no hay clave, el chatbot usa el motor determinista (reglas + fuzzy match). */
export const hasLLM = () => config.anthropicApiKey.length > 0;
