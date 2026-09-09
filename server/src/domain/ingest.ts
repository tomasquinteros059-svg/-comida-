import { transaction } from '../db/index.js';
import { badRequest } from '../lib/http.js';
import { normalize } from '../lib/text.js';
import { emit } from '../lib/events.js';
import {
  createCategory,
  createProduct,
  listCategories,
  listProducts,
  updateProduct,
} from './menu.js';
import {
  createIngredient,
  listIngredients,
  syncProductAvailability,
  updateIngredient,
} from './stock.js';
import { createKnowledge, listKnowledge, updateKnowledge } from './knowledge.js';

/**
 * Ingesta de archivos que sube el local para alimentar al bot: la carta
 * exportada del Excel, la lista de insumos, o un texto con las politicas.
 *
 * Siempre en dos pasos: primero se calcula un plan y se muestra, despues se
 * aplica. Nadie deberia enterarse de que le cambio el precio a media carta
 * despues de haberlo hecho.
 */

export type ImportKind = 'carta' | 'insumos' | 'conocimiento';

export interface ImportChange {
  label: string;
  detail: string;
}

export interface ImportPlan {
  kind: ImportKind;
  filename: string;
  rows_read: number;
  creates: ImportChange[];
  updates: ImportChange[];
  issues: { row: number; message: string }[];
}

// ── Lectura del archivo ─────────────────────────────────────────────────────

const DELIMITERS = [',', ';', '\t', '|'];

/** Elige el separador que produce columnas de forma consistente. */
function detectDelimiter(lines: string[]): string {
  let best = ',';
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const counts = lines.slice(0, 5).map((line) => splitRow(line, delimiter).length);
    const first = counts[0] ?? 1;
    if (first < 2) continue;
    const consistent = counts.every((c) => c === first);
    const score = (consistent ? 100 : 0) + first;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** Parte una fila respetando comillas dobles y "" como comilla escapada. */
export function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else quoted = false;
      } else current += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { cells.push(current.trim()); current = ''; continue; }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseTable(text: string): ParsedTable | null {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;

  const delimiter = detectDelimiter(lines);
  const headers = splitRow(lines[0]!, delimiter).map((h) => normalize(h).replace(/\s+/g, '_'));
  if (headers.length < 2) return null;

  const rows = lines.slice(1).map((line) => {
    const cells = splitRow(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
  return { headers, rows };
}

/** Primer valor no vacio entre varios nombres posibles de columna. */
const pick = (row: Record<string, string>, ...names: string[]): string => {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
};

/**
 * Lee un importe escrito como lo escribe la gente: "1.500", "$1.500,00",
 * "1500.50", "1 500". Cuando aparecen los dos separadores, el ultimo es el
 * decimal; con uno solo, se decide por la cantidad de digitos que le siguen.
 */
export function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalized: string;

  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    normalized = cleaned.slice(0, decimalAt).replace(/[.,]/g, '') + '.' + cleaned.slice(decimalAt + 1);
  } else if (lastComma >= 0) {
    const decimals = cleaned.length - lastComma - 1;
    normalized = decimals === 3 && !cleaned.slice(0, lastComma).includes(',')
      ? cleaned.replace(/,/g, '')                       // 1,500 = mil quinientos
      : cleaned.replace(',', '.');                      // 1,50 = uno con cincuenta
  } else if (lastDot >= 0) {
    const decimals = cleaned.length - lastDot - 1;
    normalized = decimals === 3 ? cleaned.replace(/\./g, '') : cleaned;
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

const parseList = (raw: string): string[] =>
  raw.split(/[,;/]/).map((v) => v.trim()).filter(Boolean);

// ── Deteccion del tipo de archivo ───────────────────────────────────────────

const HEADER_HINTS: Record<ImportKind, string[]> = {
  carta: ['precio', 'precio_venta', 'pvp', 'plato', 'producto'],
  insumos: ['stock', 'existencia', 'insumo', 'ingrediente', 'unidad', 'minimo'],
  conocimiento: ['tema', 'pregunta', 'respuesta', 'contenido'],
};

export function detectKind(table: ParsedTable | null): ImportKind {
  if (!table) return 'conocimiento';
  const headers = new Set(table.headers);
  const score = (kind: ImportKind) => HEADER_HINTS[kind].filter((h) => headers.has(h)).length;
  // "insumos" primero: una lista de insumos tambien trae la palabra "costo".
  const ranked: ImportKind[] = ['insumos', 'carta', 'conocimiento'];
  let best: ImportKind = 'conocimiento';
  let bestScore = 0;
  for (const kind of ranked) {
    const value = score(kind);
    if (value > bestScore) { bestScore = value; best = kind; }
  }
  return bestScore > 0 ? best : 'conocimiento';
}

// ── Plan ────────────────────────────────────────────────────────────────────

const money = (value: number) => `$${value.toLocaleString('es-AR')}`;

interface Draft {
  kind: ImportKind;
  products: {
    row: number; name: string; price_cents: number; cost_cents: number | null;
    description: string; category: string; tags: string[]; allergens: string[];
    existingId: string | null; before: string | null;
  }[];
  ingredients: {
    row: number; name: string; unit: string; stock_qty: number | null;
    min_qty: number | null; par_qty: number | null; cost_cents: number | null;
    existingId: string | null; before: string | null;
  }[];
  knowledge: { row: number; topic: string; content: string; existingId: string | null }[];
  issues: { row: number; message: string }[];
  rows_read: number;
}

function buildDraft(content: string, kindHint?: ImportKind): Draft {
  const table = parseTable(content);
  const kind = kindHint ?? detectKind(table);
  const draft: Draft = { kind, products: [], ingredients: [], knowledge: [], issues: [], rows_read: 0 };

  if (kind === 'conocimiento' && !table) {
    // Texto libre: cada bloque separado por linea en blanco es una entrada, y
    // un titulo markdown ("## Delivery") nombra el tema.
    const blocks = content.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const existing = listKnowledge();
    blocks.forEach((block, index) => {
      const lines = block.split('\n');
      const heading = lines[0]!.match(/^#{1,6}\s*(.+)$/);
      const topic = heading ? heading[1]!.trim() : lines[0]!.slice(0, 60).trim();
      const body = heading ? lines.slice(1).join('\n').trim() : block;
      if (!body) return;
      const match = existing.find((e) => normalize(e.topic) === normalize(topic));
      draft.knowledge.push({ row: index + 1, topic, content: body, existingId: match?.id ?? null });
    });
    draft.rows_read = blocks.length;
    return draft;
  }

  if (!table) {
    draft.issues.push({ row: 0, message: 'No pude leer el archivo: necesita al menos una fila de encabezados y una de datos.' });
    return draft;
  }

  draft.rows_read = table.rows.length;

  table.rows.forEach((row, index) => {
    const line = index + 2; // +1 por el encabezado, +1 porque las filas se cuentan desde 1
    const name = pick(row, 'nombre', 'producto', 'plato', 'insumo', 'ingrediente', 'item', 'tema', 'titulo');
    if (!name) {
      draft.issues.push({ row: line, message: 'Fila sin nombre, la salteo.' });
      return;
    }

    if (kind === 'carta') {
      const priceRaw = pick(row, 'precio', 'precio_venta', 'pvp', 'importe');
      const price = parseAmount(priceRaw);
      if (price === null || price <= 0) {
        draft.issues.push({ row: line, message: `"${name}": no pude leer el precio ("${priceRaw}").` });
        return;
      }
      const cost = parseAmount(pick(row, 'costo', 'costo_plato', 'cmv'));
      const existing = listProducts().find((p) => normalize(p.name) === normalize(name));
      draft.products.push({
        row: line,
        name,
        price_cents: Math.round(price * 100),
        cost_cents: cost === null ? null : Math.round(cost * 100),
        description: pick(row, 'descripcion', 'detalle', 'ingredientes'),
        category: pick(row, 'categoria', 'rubro', 'seccion', 'grupo'),
        tags: parseList(pick(row, 'etiquetas', 'tags')),
        allergens: parseList(pick(row, 'alergenos', 'alergenos_')),
        existingId: existing?.id ?? null,
        before: existing ? money(existing.price_cents / 100) : null,
      });
      return;
    }

    if (kind === 'insumos') {
      const existing = listIngredients().find((i) => normalize(i.name) === normalize(name));
      const cost = parseAmount(pick(row, 'costo', 'precio', 'costo_unitario'));
      draft.ingredients.push({
        row: line,
        name,
        unit: pick(row, 'unidad', 'um', 'medida') || existing?.unit || 'un',
        stock_qty: parseAmount(pick(row, 'stock', 'cantidad', 'existencia', 'actual')),
        min_qty: parseAmount(pick(row, 'minimo', 'min', 'punto_reposicion')),
        par_qty: parseAmount(pick(row, 'objetivo', 'par', 'maximo', 'optimo')),
        cost_cents: cost === null ? null : Math.round(cost * 100),
        existingId: existing?.id ?? null,
        before: existing ? `${existing.stock_qty} ${existing.unit}` : null,
      });
      return;
    }

    const body = pick(row, 'contenido', 'texto', 'respuesta', 'detalle', 'descripcion');
    if (!body) {
      draft.issues.push({ row: line, message: `"${name}": no tiene contenido.` });
      return;
    }
    const match = listKnowledge().find((e) => normalize(e.topic) === normalize(name));
    draft.knowledge.push({ row: line, topic: name, content: body, existingId: match?.id ?? null });
  });

  return draft;
}

export function planImport(input: { content: string; filename?: string; kind?: ImportKind }): ImportPlan {
  if (!input.content.trim()) throw badRequest('El archivo está vacío');
  const draft = buildDraft(input.content, input.kind);

  const creates: ImportChange[] = [];
  const updates: ImportChange[] = [];

  for (const p of draft.products) {
    const detail = `${money(p.price_cents / 100)}${p.category ? ` · ${p.category}` : ''}`;
    if (p.existingId) updates.push({ label: p.name, detail: `${p.before} → ${detail}` });
    else creates.push({ label: p.name, detail });
  }
  for (const i of draft.ingredients) {
    const detail = `${i.stock_qty ?? '—'} ${i.unit}${i.min_qty !== null ? ` · mín ${i.min_qty}` : ''}`;
    if (i.existingId) updates.push({ label: i.name, detail: `${i.before} → ${detail}` });
    else creates.push({ label: i.name, detail });
  }
  for (const k of draft.knowledge) {
    const detail = k.content.length > 70 ? `${k.content.slice(0, 70)}…` : k.content;
    if (k.existingId) updates.push({ label: k.topic, detail });
    else creates.push({ label: k.topic, detail });
  }

  return {
    kind: draft.kind,
    filename: input.filename ?? 'archivo',
    rows_read: draft.rows_read,
    creates,
    updates,
    issues: draft.issues,
  };
}

export interface ImportResult extends ImportPlan {
  applied: boolean;
  created: number;
  updated: number;
}

/**
 * Aplica el import. Vuelve a calcular el plan del contenido en vez de confiar
 * en el que mando el navegador: lo que se escribe sale siempre del archivo.
 */
export function applyImport(input: { content: string; filename?: string; kind?: ImportKind }): ImportResult {
  const draft = buildDraft(input.content, input.kind);
  const plan = planImport(input);
  let created = 0;
  let updated = 0;

  transaction(() => {
    const categories = new Map(listCategories().map((c) => [normalize(c.name), c.id]));

    for (const p of draft.products) {
      let categoryId: string | null = null;
      if (p.category) {
        const key = normalize(p.category);
        categoryId = categories.get(key) ?? null;
        if (!categoryId) {
          categoryId = createCategory({ name: p.category, position: categories.size }).id;
          categories.set(key, categoryId);
        }
      }
      const patch = {
        name: p.name,
        price_cents: p.price_cents,
        ...(p.cost_cents === null ? {} : { cost_cents: p.cost_cents }),
        ...(p.description ? { description: p.description } : {}),
        ...(categoryId ? { category_id: categoryId } : {}),
        ...(p.tags.length ? { tags: p.tags } : {}),
        ...(p.allergens.length ? { allergens: p.allergens } : {}),
      };
      if (p.existingId) { updateProduct(p.existingId, patch); updated++; }
      else { createProduct(patch); created++; }
    }

    for (const i of draft.ingredients) {
      const patch = {
        name: i.name,
        unit: i.unit,
        ...(i.stock_qty === null ? {} : { stock_qty: i.stock_qty }),
        ...(i.min_qty === null ? {} : { min_qty: i.min_qty }),
        ...(i.par_qty === null ? {} : { par_qty: i.par_qty }),
        ...(i.cost_cents === null ? {} : { cost_cents: i.cost_cents }),
      };
      if (i.existingId) { updateIngredient(i.existingId, patch); updated++; }
      else { createIngredient(patch); created++; }
    }

    for (const k of draft.knowledge) {
      if (k.existingId) { updateKnowledge(k.existingId, { content: k.content }); updated++; }
      else { createKnowledge({ topic: k.topic, content: k.content }); created++; }
    }
  });

  // Si entro stock nuevo, la carta puede volver a ofrecer platos que estaban
  // caidos; si bajo, tiene que dejar de ofrecerlos.
  if (draft.kind === 'insumos') syncProductAvailability();

  emit(draft.kind === 'insumos' ? 'stock' : draft.kind === 'carta' ? 'carta' : 'conocimiento', 'import');
  return { ...plan, applied: true, created, updated };
}
