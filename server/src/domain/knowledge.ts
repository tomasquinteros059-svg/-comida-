import { all, get, run, toDbBool } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { notFound } from '../lib/http.js';
import { emit } from '../lib/events.js';

export interface KnowledgeEntry {
  id: string;
  topic: string;
  content: string;
  priority: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface KnowledgeRow extends Omit<KnowledgeEntry, 'active'> {
  active: number;
}

const map = (row: KnowledgeRow): KnowledgeEntry => ({ ...row, active: row.active === 1 });

export const listKnowledge = (onlyActive = false): KnowledgeEntry[] =>
  all<KnowledgeRow>(
    `SELECT * FROM knowledge ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY priority DESC, topic`,
  ).map(map);

export function createKnowledge(input: { topic: string; content: string; priority?: number }): KnowledgeEntry {
  const id = newId('kb');
  run('INSERT INTO knowledge (id, topic, content, priority) VALUES (?,?,?,?)', [
    id,
    input.topic,
    input.content,
    input.priority ?? 0,
  ]);
  return map(get<KnowledgeRow>('SELECT * FROM knowledge WHERE id = ?', [id])!);
}

export function updateKnowledge(id: string, patch: Partial<KnowledgeEntry>): KnowledgeEntry {
  const row = get<KnowledgeRow>('SELECT * FROM knowledge WHERE id = ?', [id]);
  if (!row) throw notFound('Entrada de conocimiento');
  const next = { ...map(row), ...patch };
  run(
    `UPDATE knowledge SET topic = ?, content = ?, priority = ?, active = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [next.topic, next.content, next.priority, toDbBool(next.active), id],
  );
  emit('conocimiento', next.topic);
  return map(get<KnowledgeRow>('SELECT * FROM knowledge WHERE id = ?', [id])!);
}

export function deleteKnowledge(id: string): void {
  run('DELETE FROM knowledge WHERE id = ?', [id]);
  emit('conocimiento', 'entrada eliminada');
}

/** Bloque de texto que se inyecta al prompt del bot. */
export function knowledgeAsText(): string {
  const entries = listKnowledge(true);
  if (!entries.length) return '';
  return entries.map((e) => `- ${e.topic}: ${e.content}`).join('\n');
}
