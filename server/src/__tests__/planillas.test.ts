import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { useTempDatabase } from './helpers.js';

useTempDatabase('planillas');

const { closeDb } = await import('../db/index.js');
const planillas = await import('../domain/planillas.js');
const { planImport, applyImport } = await import('../domain/ingest.js');

after(() => closeDb());

/** Arma un .xlsx de verdad en memoria, igual al que exportaría un local. */
async function excelDePrueba(
  filas: unknown[][],
  opciones: { hojas?: Array<{ nombre: string; filas: unknown[][] }> } = {},
): Promise<Buffer> {
  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Carta');
  for (const f of filas) hoja.addRow(f);
  for (const extra of opciones.hojas ?? []) {
    const h = libro.addWorksheet(extra.nombre);
    for (const f of extra.filas) h.addRow(f);
  }
  return Buffer.from(await libro.xlsx.writeBuffer());
}

describe('leer un Excel', () => {
  it('saca las filas y las deja como tabla', async () => {
    const archivo = await excelDePrueba([
      ['nombre', 'categoria', 'precio'],
      ['Pizza muzzarella', 'Pizzas', 11000],
      ['Empanada de carne', 'Empanadas', 1500],
    ]);
    const lectura = await planillas.leerExcel(archivo);
    assert.equal(lectura.filas, 2);
    assert.match(lectura.origen, /Excel/);
    assert.match(lectura.texto, /Pizza muzzarella\|Pizzas\|11000/);
  });

  it('una carta en Excel entra a la carta, sin pasar por CSV', async () => {
    const archivo = await excelDePrueba([
      ['nombre', 'categoria', 'precio'],
      ['Fugazzeta rellena', 'Pizzas', '$14.500'],
      ['Milanesa a caballo', 'Milanesas', '$18.900'],
    ]);
    const lectura = await planillas.leerExcel(archivo);
    const plan = planImport({ content: lectura.texto, filename: 'carta.xlsx' });

    assert.equal(plan.kind, 'carta');
    assert.equal(plan.creates.length, 2);
    assert.match(plan.creates[0]!.detail, /14\.500/);

    const resultado = applyImport({ content: lectura.texto, filename: 'carta.xlsx' });
    assert.equal(resultado.creates.length, 2);

    const { listProducts } = await import('../domain/menu.js');
    const fugazzeta = listProducts({ includeUnavailable: true }).find((p) => p.name === 'Fugazzeta rellena');
    assert.equal(fugazzeta?.price_cents, 1_450_000, '$14.500 son 1.450.000 centavos, no 14.500');
  });

  it('lee las fórmulas por su resultado, no por la fórmula', async () => {
    const libro = new ExcelJS.Workbook();
    const hoja = libro.addWorksheet('Carta');
    hoja.addRow(['nombre', 'categoria', 'precio']);
    const fila = hoja.addRow(['Combo familiar', 'Combos', null]);
    fila.getCell(3).value = { formula: 'A1*2', result: 24000 };
    const archivo = Buffer.from(await libro.xlsx.writeBuffer());

    const lectura = await planillas.leerExcel(archivo);
    assert.match(lectura.texto, /Combo familiar\|Combos\|24000/);
  });

  it('avisa cuando hay varias hojas, en vez de mezclarlas', async () => {
    const archivo = await excelDePrueba(
      [['nombre', 'categoria', 'precio'], ['Pizza', 'Pizzas', 11000]],
      { hojas: [{ nombre: 'Cuentas viejas', filas: [['enero', 'febrero'], [1, 2]] }] },
    );
    const lectura = await planillas.leerExcel(archivo);
    assert.match(lectura.avisos.join(' '), /2 hojas/);
    assert.ok(!lectura.texto.includes('enero'), 'no puede mezclar la hoja de cuentas con la carta');
  });

  it('un Excel sin datos lo dice claro', async () => {
    const vacio = await excelDePrueba([['nombre', 'categoria', 'precio']]);
    await assert.rejects(planillas.leerExcel(vacio), /dos filas/);
  });

  it('un archivo que no es un Excel no se hace pasar por uno', async () => {
    await assert.rejects(planillas.leerExcel(Buffer.from('esto no es un xlsx')));
  });
});

describe('leer un PDF', () => {
  /**
   * Un PDF mínimo escrito a mano, con el texto en posiciones reales. Es lo
   * mismo que exporta un diseñador: nombre a la izquierda, precio a la derecha.
   */
  function pdfDePrueba(renglones: Array<{ izq: string; der: string; y: number }>): Buffer {
    const ops = renglones
      .flatMap(({ izq, der, y }) => [
        `BT /F1 12 Tf 60 ${y} Td (${izq}) Tj ET`,
        `BT /F1 12 Tf 420 ${y} Td (${der}) Tj ET`,
      ])
      .join('\n');
    const stream = `${ops}\n`;
    const objetos = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objetos.forEach((o, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const inicioXref = pdf.length;
    pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }

  it('reconstruye los renglones de una carta de diseñador', async () => {
    const archivo = pdfDePrueba([
      { izq: 'nombre', der: 'precio', y: 760 },
      { izq: 'Pizza muzzarella', der: '11000', y: 720 },
      { izq: 'Fugazzeta rellena', der: '14500', y: 690 },
    ]);
    const lectura = await planillas.leerPdf(archivo);

    assert.ok(lectura.filas >= 3, `salieron ${lectura.filas} renglones`);
    assert.match(lectura.texto, /Pizza muzzarella\|11000/, 'el hueco grande es un salto de columna');
    assert.match(lectura.texto, /Fugazzeta rellena\|14500/);
  });

  it('respeta el orden de arriba hacia abajo', async () => {
    const archivo = pdfDePrueba([
      { izq: 'nombre', der: 'precio', y: 760 },
      { izq: 'Primero', der: '100', y: 720 },
      { izq: 'Segundo', der: '200', y: 690 },
    ]);
    const { texto } = await planillas.leerPdf(archivo);
    assert.ok(texto.indexOf('Primero') < texto.indexOf('Segundo'), 'en PDF el eje Y crece hacia arriba');
  });

  it('avisa que lo reconstruyó y que hay que revisarlo', async () => {
    const archivo = pdfDePrueba([{ izq: 'nombre', der: 'precio', y: 760 }, { izq: 'Pizza', der: '11000', y: 720 }]);
    const { avisos } = await planillas.leerPdf(archivo);
    assert.match(avisos.join(' '), /Revisá bien la vista previa/);
  });

  it('un PDF escaneado explica por qué no se puede', async () => {
    const sinTexto = pdfDePrueba([]);
    await assert.rejects(planillas.leerPdf(sinTexto), /escaneo|imagen/i);
  });
});

describe('la puerta de entrada', () => {
  it('reconoce el formato por la extensión', () => {
    assert.equal(planillas.formatoDe('carta.xlsx'), 'excel');
    assert.equal(planillas.formatoDe('CARTA.XLS'), 'excel');
    assert.equal(planillas.formatoDe('menu.pdf'), 'pdf');
    assert.equal(planillas.formatoDe('carta.csv'), 'texto');
    assert.equal(planillas.formatoDe(''), 'texto');
  });

  it('un CSV sigue entrando como antes', async () => {
    const lectura = await planillas.aTextoDeTabla({
      content: 'nombre,categoria,precio\nFlan,Postres,$2.800',
      filename: 'postres.csv',
    });
    assert.equal(lectura.origen, 'texto');
    assert.match(lectura.texto, /Flan/);
  });

  it('un Excel en base64 entra entero', async () => {
    const archivo = await excelDePrueba([['nombre', 'categoria', 'precio'], ['Tiramisu', 'Postres', 4200]]);
    const lectura = await planillas.aTextoDeTabla({
      content: archivo.toString('base64'),
      filename: 'postres.xlsx',
      base64: true,
    });
    assert.match(lectura.texto, /Tiramisu/);
  });

  it('un binario mandado como texto lo dice, en vez de romperse raro', async () => {
    await assert.rejects(
      planillas.aTextoDeTabla({ content: 'lo que sea', filename: 'carta.xlsx' }),
      /base64/,
    );
  });

  it('un archivo vacío lo dice', async () => {
    await assert.rejects(
      planillas.aTextoDeTabla({ content: '', filename: 'carta.xlsx', base64: true }),
      /vacío|vacio|empty/i,
    );
  });
});
