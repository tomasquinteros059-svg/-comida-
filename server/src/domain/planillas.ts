import ExcelJS from 'exceljs';

/**
 * Leer la carta desde un Excel o un PDF.
 *
 * Hasta ahora había que exportar a CSV primero, y ese paso extra es donde la
 * mayoría abandona: casi ningún local tiene la carta en CSV. La tiene en un
 * Excel que armó alguien, o en el PDF que le mandó el diseñador.
 *
 * Lo que sale de acá es el mismo texto delimitado que ya sabe leer la ingesta.
 * Así el resto —la previsualización, la detección de qué tipo de planilla es,
 * el aplicar— no se entera de por dónde entró el archivo.
 */

/** El separador: una barra vertical no aparece en nombres de platos. */
const SEP = '|';

const limpiar = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    // Las celdas con fórmula traen { formula, result }; las de texto enriquecido,
    // { richText: [...] }. En los dos casos lo que sirve es el valor visible.
    const celda = v as { result?: unknown; richText?: Array<{ text?: string }>; text?: string };
    if (celda.richText) return celda.richText.map((t) => t.text ?? '').join('');
    if (celda.text !== undefined) return String(celda.text);
    if (celda.result !== undefined) return limpiar(celda.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v).replace(/[|\r\n]+/g, ' ').trim();
};

export interface LecturaDePlanilla {
  texto: string;
  /** De dónde salió, para poder decírselo a quien lo sube. */
  origen: string;
  filas: number;
  /** Lo que no se pudo leer, para no fingir que salió todo bien. */
  avisos: string[];
}

// ── Excel ───────────────────────────────────────────────────────────────────

/**
 * Lee la primera hoja con datos. No todas: un Excel de carta suele tener una
 * hoja con los platos y tres con cuentas viejas, y mezclarlas es peor que
 * ignorarlas.
 */
export async function leerExcel(datos: Buffer): Promise<LecturaDePlanilla> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(datos as unknown as ArrayBuffer);

  const avisos: string[] = [];
  const hojas = libro.worksheets.filter((h) => h.rowCount > 1);
  // Si ninguna tiene datos, igual se toma la primera con algo escrito: asi el
  // error que ve quien sube el archivo es el especifico ("falta el encabezado
  // y al menos un dato") y no un "no hay ninguna hoja" que no dice que hacer.
  const conAlgo = hojas.length ? hojas : libro.worksheets.filter((h) => h.rowCount >= 1);
  if (!conAlgo.length) throw new Error('El Excel no tiene ninguna hoja con datos');

  const hoja = conAlgo[0]!;
  if (hojas.length > 1) {
    avisos.push(
      `El archivo tiene ${hojas.length} hojas con datos. Se leyó "${hoja.name}"; ` +
        `si la carta está en otra, guardala como la primera.`,
    );
  }

  const filas: string[] = [];
  let anchoMaximo = 0;

  hoja.eachRow({ includeEmpty: false }, (fila) => {
    const celdas: string[] = [];
    // `values` viene con un hueco en la posición 0 porque Excel cuenta desde 1.
    const valores = (fila.values as unknown[]).slice(1);
    for (const v of valores) celdas.push(limpiar(v));

    // Sacar las columnas vacías del final: los Excel suelen traer cola de vacías.
    while (celdas.length && celdas[celdas.length - 1] === '') celdas.pop();
    if (!celdas.length) return;

    anchoMaximo = Math.max(anchoMaximo, celdas.length);
    filas.push(celdas.join(SEP));
  });

  if (filas.length < 2) throw new Error('La hoja tiene menos de dos filas: hace falta el encabezado y al menos un dato');

  return {
    texto: filas.join('\n'),
    origen: `Excel · hoja "${hoja.name}"`,
    filas: filas.length - 1,
    avisos,
  };
}

// ── PDF ─────────────────────────────────────────────────────────────────────

interface Fragmento {
  texto: string;
  x: number;
  y: number;
}

/**
 * Saca el texto de un PDF y trata de reconstruir las filas.
 *
 * Un PDF no tiene filas ni columnas: tiene fragmentos de texto con una
 * posición. Una carta de diseñador es justamente eso —el nombre del plato a la
 * izquierda, el precio a la derecha, y entre medio nada— así que se agrupa por
 * altura para rearmar cada renglón y se corta donde hay un salto grande.
 *
 * Esto acierta bastante y falla a veces, y está bien que así sea: por eso la
 * ingesta muestra lo que cambiaría ANTES de aplicar. Quien sube el archivo lo
 * mira y corrige.
 */
export async function leerPdf(datos: Buffer): Promise<LecturaDePlanilla> {
  // La build "legacy" es la que anda en Node sin un DOM alrededor.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const documento = await pdfjs.getDocument({
    data: new Uint8Array(datos),
    // Sin worker: en el servidor no hay ventaja y complica el empaquetado.
    useWorkerFetch: false,
    useSystemFonts: true,
  }).promise;

  const avisos: string[] = [];
  const renglones: string[] = [];

  for (let n = 1; n <= documento.numPages; n++) {
    const pagina = await documento.getPage(n);
    const contenido = await pagina.getTextContent();

    const fragmentos: Fragmento[] = [];
    for (const item of contenido.items) {
      const it = item as { str?: string; transform?: number[] };
      const texto = (it.str ?? '').trim();
      if (!texto || !it.transform) continue;
      fragmentos.push({ texto, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0 });
    }

    if (!fragmentos.length) continue;

    // Agrupar por altura: lo que está a la misma altura es el mismo renglón.
    // Tres puntos de tolerancia cubren la diferencia entre una mayúscula y un
    // número en la misma línea.
    const porAltura = new Map<number, Fragmento[]>();
    for (const f of fragmentos) {
      const clave = Math.round(f.y / 3) * 3;
      const grupo = porAltura.get(clave) ?? [];
      grupo.push(f);
      porAltura.set(clave, grupo);
    }

    // De arriba hacia abajo: en PDF el eje Y crece hacia arriba.
    const alturas = [...porAltura.keys()].sort((a, b) => b - a);
    for (const altura of alturas) {
      const grupo = porAltura.get(altura)!.sort((a, b) => a.x - b.x);
      // Un hueco grande entre dos fragmentos es un salto de columna, no un
      // espacio: así se separa "Pizza muzzarella" de "$11.000".
      const celdas: string[] = [];
      let actual = grupo[0]!.texto;
      for (let i = 1; i < grupo.length; i++) {
        const previo = grupo[i - 1]!;
        const f = grupo[i]!;
        const hueco = f.x - (previo.x + previo.texto.length * 4.2);
        if (hueco > 18) {
          celdas.push(actual);
          actual = f.texto;
        } else {
          actual += ` ${f.texto}`;
        }
      }
      celdas.push(actual);
      const renglon = celdas.map((c) => c.trim()).filter(Boolean).join(SEP);
      if (renglon) renglones.push(renglon);
    }
  }

  if (!renglones.length) {
    throw new Error(
      'No se pudo sacar texto del PDF. Si es un escaneo o una foto, el texto es una imagen ' +
        'y hay que pasarlo a Excel o CSV a mano.',
    );
  }

  if (documento.numPages > 1) {
    avisos.push(`El PDF tiene ${documento.numPages} páginas y se leyeron todas, una abajo de la otra.`);
  }
  avisos.push(
    'Un PDF no tiene filas ni columnas: se reconstruyeron a partir de dónde está cada texto. ' +
      'Revisá bien la vista previa antes de aplicar.',
  );

  return {
    texto: renglones.join('\n'),
    origen: `PDF · ${documento.numPages} ${documento.numPages === 1 ? 'página' : 'páginas'}`,
    filas: renglones.length,
    avisos,
  };
}

// ── Puerta de entrada ───────────────────────────────────────────────────────

export type FormatoDeArchivo = 'texto' | 'excel' | 'pdf';

export function formatoDe(filename = ''): FormatoDeArchivo {
  const n = filename.toLowerCase();
  if (n.endsWith('.xlsx') || n.endsWith('.xlsm') || n.endsWith('.xls')) return 'excel';
  if (n.endsWith('.pdf')) return 'pdf';
  return 'texto';
}

/**
 * Convierte lo que se subió en el texto delimitado que ya sabe leer la
 * ingesta, venga de donde venga.
 */
export async function aTextoDeTabla(input: {
  content: string;
  filename?: string;
  /** El contenido viene en base64 cuando el archivo es binario. */
  base64?: boolean;
}): Promise<LecturaDePlanilla> {
  const formato = formatoDe(input.filename);

  if (formato === 'texto') {
    const filas = input.content.split(/\r?\n/).filter((l) => l.trim()).length;
    return { texto: input.content, origen: 'texto', filas: Math.max(0, filas - 1), avisos: [] };
  }

  if (!input.base64) {
    throw new Error(`Un ${formato === 'excel' ? 'Excel' : 'PDF'} hay que mandarlo en base64`);
  }

  const datos = Buffer.from(input.content, 'base64');
  if (!datos.length) throw new Error('El archivo llegó vacío');

  return formato === 'excel' ? leerExcel(datos) : leerPdf(datos);
}
