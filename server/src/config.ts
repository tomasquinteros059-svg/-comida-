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
  chatModel: process.env.CHAT_MODEL?.trim() || 'claude-opus-5',
  /**
   * Cuanto "piensa" el modelo antes de responder. Tomar un pedido es una tarea
   * simple y el cliente esta esperando: "low" responde mas rapido y mas barato,
   * y para esto alcanza. Subilo si el local tiene una carta muy enredada.
   */
  chatEffort: (process.env.CHAT_EFFORT?.trim() || 'low') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  adminToken: process.env.ADMIN_TOKEN?.trim() || '',
  /**
   * Origenes que pueden llamar a la API desde otro dominio. Vacio = solo el
   * mismo origen, que es lo que corresponde cuando el panel se sirve desde
   * este mismo proceso.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  /**
   * Saltos de proxy en los que confiar para leer la IP real (X-Forwarded-For).
   * Detras de un nginx o un Caddy es 1. Dejarlo en 0 cuando el proceso mira a
   * internet directo: si no, cualquiera falsea su IP y esquiva el limite.
   */
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  /**
   * Intentos de ingreso por minuto y por IP. Cinco alcanzan para el que se
   * equivoco escribiendo y no para el que prueba un diccionario. Se puede
   * subir en desarrollo o en las pruebas.
   */
  loginRateMax: Number(process.env.LOGIN_RATE_MAX ?? 5),
  chatRateLimit: {
    windowMs: Number(process.env.CHAT_RATE_WINDOW_MS ?? 60_000),
    max: Number(process.env.CHAT_RATE_MAX ?? 20),
  },
  currency: process.env.CURRENCY ?? 'ARS',
  timezone: process.env.TIMEZONE ?? 'America/Argentina/Buenos_Aires',
};

/** Si no hay clave, el chatbot usa el motor determinista (reglas + fuzzy match). */
export const hasLLM = () => config.anthropicApiKey.length > 0;

export const isProduction = () => config.env === 'production';

/**
 * Revisa la configuracion antes de aceptar trafico. Devuelve los problemas
 * que impiden arrancar en produccion.
 *
 * El caso que importa: sin ADMIN_TOKEN el panel queda abierto. En una notebook
 * eso es comodo; en internet significa que cualquiera edita la carta, ve la
 * facturacion y le manda ordenes de compra a los proveedores del local.
 */
export function configProblems(): string[] {
  const problems: string[] = [];
  if (!isProduction()) return problems;

  if (!config.adminToken) {
    problems.push(
      'Falta ADMIN_TOKEN. Sin el, el panel de administracion queda abierto a ' +
        'cualquiera que conozca la URL. Genera uno con: openssl rand -base64 32',
    );
  } else if (config.adminToken.length < 16) {
    problems.push('ADMIN_TOKEN es muy corto: usa al menos 16 caracteres.');
  }
  return problems;
}
