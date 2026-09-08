/** Normaliza para comparar: minusculas, sin tildes, sin puntuacion, sin espacios extra. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'con', 'sin',
  'y', 'o', 'a', 'al', 'para', 'por', 'quiero', 'dame', 'traeme', 'me', 'das',
  'gustaria', 'poner', 'ponme', 'agrega', 'agregame', 'que', 'tienen', 'hay',
]);

export const tokenize = (text: string): string[] =>
  normalize(text).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));

/** Distancia de Levenshtein acotada, para tolerar tipeos ("milaneza" -> "milanesa"). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * Puntaje 0..1 de que tan bien `query` describe a `target`.
 * Combina coincidencia exacta, por token y difusa.
 */
export function similarity(query: string, target: string): number {
  const q = normalize(query);
  const t = normalize(target);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.includes(q)) return 0.9 - Math.min(0.2, (t.length - q.length) / 100);
  if (q.includes(t)) return 0.85;

  const qTokens = tokenize(query);
  const tTokens = new Set(tokenize(target));
  if (!qTokens.length || !tTokens.size) return 0;

  let hits = 0;
  for (const token of qTokens) {
    if (tTokens.has(token)) { hits += 1; continue; }
    for (const candidate of tTokens) {
      const dist = levenshtein(token, candidate);
      const tolerance = candidate.length <= 4 ? 1 : 2;
      if (dist <= tolerance) { hits += 0.8; break; }
    }
  }
  return Math.min(0.8, hits / qTokens.length * 0.8);
}
