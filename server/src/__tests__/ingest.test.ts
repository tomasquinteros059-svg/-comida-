import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('ingest');

const { closeDb } = await import('../db/index.js');
const { createCategory, createProduct, listProducts } = await import('../domain/menu.js');
const { createIngredient, listIngredients } = await import('../domain/stock.js');
const { listKnowledge } = await import('../domain/knowledge.js');
const { applyImport, detectKind, parseAmount, parseTable, planImport } = await import('../domain/ingest.js');

before(() => {
  const category = createCategory({ name: 'Empanadas' }).id;
  // Todo el dinero va en centavos: 150_000 centavos son $1.500.
  createProduct({ name: 'Empanada de carne', category_id: category, price_cents: 150_000, cost_cents: 52_000 });
  createIngredient({ name: 'Tapas de empanada', unit: 'un', stock_qty: 100, min_qty: 200, par_qty: 600 });
});

after(() => closeDb());

describe('lectura de importes', () => {
  it('entiende como escribe la gente los precios', () => {
    assert.equal(parseAmount('1500'), 1500);
    assert.equal(parseAmount('$1.500'), 1500);          // miles con punto
    assert.equal(parseAmount('1.500,50'), 1500.5);      // formato argentino
    assert.equal(parseAmount('1,500.50'), 1500.5);      // formato ingles
    assert.equal(parseAmount('1500.50'), 1500.5);       // decimal con punto
    assert.equal(parseAmount('12,50'), 12.5);           // decimal con coma
    assert.equal(parseAmount('$ 9.800 '), 9800);
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount('s/d'), null);
  });
});

describe('lectura del archivo', () => {
  it('detecta el separador y respeta las comillas', () => {
    const table = parseTable('nombre;precio;descripcion\n"Milanesa, napolitana";12500;"Con papas"');
    assert.equal(table?.rows.length, 1);
    assert.equal(table?.rows[0]?.nombre, 'Milanesa, napolitana');
    assert.equal(table?.rows[0]?.precio, '12500');
  });

  it('reconoce que tipo de archivo es por sus columnas', () => {
    assert.equal(detectKind(parseTable('nombre,precio\nPizza,11000')), 'carta');
    assert.equal(detectKind(parseTable('insumo,unidad,stock,minimo\nHarina,kg,20,5')), 'insumos');
    assert.equal(detectKind(parseTable('tema,contenido\nHorarios,De 11 a 23')), 'conocimiento');
  });
});

describe('vista previa', () => {
  it('separa lo que crea de lo que actualiza, y no toca nada', () => {
    const csv = 'nombre,precio,categoria\nEmpanada de carne,1800,Empanadas\nPizza fugazzeta,15800,Pizzas';
    const plan = planImport({ content: csv, filename: 'carta.csv' });

    assert.equal(plan.kind, 'carta');
    assert.equal(plan.rows_read, 2);
    assert.equal(plan.updates.length, 1);
    assert.equal(plan.creates.length, 1);
    assert.match(plan.updates[0]!.detail, /\$1\.500 → \$1\.800/);
    // La vista previa no escribe.
    assert.equal(listProducts().find((p) => p.name === 'Pizza fugazzeta'), undefined);
    assert.equal(listProducts().find((p) => p.name === 'Empanada de carne')!.price_cents, 150_000);
  });

  it('reporta las filas que no puede leer en vez de tragarlas', () => {
    const plan = planImport({ content: 'nombre,precio\nPizza,\n,11000\nTarta,8000' });
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.issues.length, 2);
    assert.match(plan.issues[0]!.message, /precio/);
  });
});

describe('aplicar el import', () => {
  it('crea y actualiza productos, y arma la categoria si falta', () => {
    const csv = 'nombre,precio,costo,categoria,etiquetas\nEmpanada de carne,1800,600,Empanadas,\nTarta de verdura,9500,3000,Tartas,vegetariano';
    const result = applyImport({ content: csv, filename: 'carta.csv' });

    assert.equal(result.created, 1);
    assert.equal(result.updated, 1);

    const products = listProducts();
    assert.equal(products.find((p) => p.name === 'Empanada de carne')!.price_cents, 180_000);
    const tarta = products.find((p) => p.name === 'Tarta de verdura')!;
    assert.equal(tarta.price_cents, 950_000);
    assert.equal(tarta.category_name, 'Tartas');
    assert.deepEqual(tarta.tags, ['vegetariano']);
  });

  it('actualiza el stock de insumos y crea los que faltan', () => {
    const csv = 'insumo,unidad,stock,minimo,objetivo\nTapas de empanada,un,540,200,600\nHarina 000,kg,25,10,40';
    const result = applyImport({ content: csv, filename: 'insumos.csv' });

    assert.equal(result.kind, 'insumos');
    const ingredients = listIngredients();
    assert.equal(ingredients.find((i) => i.name === 'Tapas de empanada')!.stock_qty, 540);
    assert.equal(ingredients.find((i) => i.name === 'Harina 000')!.min_qty, 10);
  });

  it('toma un texto libre como base de conocimiento', () => {
    const text = '## Delivery\nEnviamos en un radio de 3 km. El envío cuesta $1.800.\n\n## Reservas\nTomamos reservas para grupos de más de 6.';
    const result = applyImport({ content: text, filename: 'politicas.md' });

    assert.equal(result.kind, 'conocimiento');
    assert.equal(result.created, 2);
    const entries = listKnowledge();
    assert.ok(entries.some((e) => e.topic === 'Delivery' && e.content.includes('3 km')));
  });

  it('no duplica una entrada que ya existe: la actualiza', () => {
    const result = applyImport({ content: '## Delivery\nAhora enviamos en 5 km.', filename: 'politicas.md' });
    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.match(listKnowledge().find((e) => e.topic === 'Delivery')!.content, /5 km/);
  });
});
