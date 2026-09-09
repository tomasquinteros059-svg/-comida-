import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cada archivo de test corre contra su propia base efimera.
 * Se define la variable antes de importar cualquier modulo que lea config.
 */
export function useTempDatabase(name: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `comeia-${name}-`));
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  process.env.ANTHROPIC_API_KEY = '';
}
