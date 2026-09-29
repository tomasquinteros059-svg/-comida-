import { claveDeChat, config } from '../config.js';
import type { ToolDefinition } from './tools.js';

/**
 * El motor del chat con Gemini.
 *
 * Hace lo mismo que el de Anthropic —entiende el pedido y llama a las mismas
 * herramientas— pero la API tiene otra forma, y las diferencias no son de
 * estilo:
 *
 *   · el rol del modelo se llama "model" y no "assistant";
 *   · las herramientas van adentro de `functionDeclarations`, no sueltas;
 *   · el resultado de una herramienta vuelve como `functionResponse` con el
 *     NOMBRE de la función, no con un id de la llamada. Si el modelo pide dos
 *     herramientas distintas en un turno, lo que las aparea es el nombre;
 *   · el esquema de parámetros acepta un subconjunto de JSON Schema y se
 *     enoja con lo que no conoce, así que hay que limpiarlo.
 *
 * Por eso vive aparte en vez de meterse con condicionales adentro del otro: un
 * bucle con dos formas de mensaje adentro no se entiende en seis meses.
 */

const RAIZ = 'https://generativelanguage.googleapis.com/v1beta';

export interface Traza {
  tool: string;
  input: unknown;
  output: unknown;
}

export interface Resultado {
  reply: string;
  trace: Traza[];
}

/** Un pedazo de contenido, en la forma que espera Gemini. */
interface Parte {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface Contenido {
  role: 'user' | 'model';
  parts: Parte[];
}

/**
 * Deja el esquema con lo que Gemini entiende.
 *
 * Gemini acepta un subconjunto de JSON Schema y RECHAZA la llamada entera si
 * encuentra una clave que no conoce —`additionalProperties`, `$schema`,
 * `default`— en vez de ignorarla. El error que devuelve habla del esquema en
 * general y no dice cuál fue, así que conviene no mandarle nada de más.
 */
export function limpiarEsquema(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(limpiarEsquema);
  if (!valor || typeof valor !== 'object') return valor;

  const permitidas = new Set([
    'type', 'description', 'properties', 'required', 'items', 'enum', 'nullable', 'format',
  ]);

  const salida: Record<string, unknown> = {};
  for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
    if (!permitidas.has(clave)) continue;

    // `properties` NO es un esquema: es un mapa de nombre → esquema. Pasarlo
    // por el mismo filtro borra los nombres de los parámetros —"texto",
    // "cantidad"— porque no están en la lista de palabras permitidas, y la
    // herramienta le llega al modelo sin argumentos. El modelo la llama igual,
    // vacía, y el pedido sale mal sin que nada falle.
    if (clave === 'properties' && v && typeof v === 'object') {
      const propiedades: Record<string, unknown> = {};
      for (const [nombre, esquema] of Object.entries(v as Record<string, unknown>)) {
        propiedades[nombre] = limpiarEsquema(esquema);
      }
      salida[clave] = propiedades;
      continue;
    }

    salida[clave] = limpiarEsquema(v);
  }
  return salida;
}

/** Las herramientas, en la forma de Gemini. */
export function herramientasParaGemini(tools: ToolDefinition[]): unknown {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: limpiarEsquema(t.input_schema),
      })),
    },
  ];
}

export class ErrorDeGemini extends Error {}

/** Una llamada a Gemini. Tira `ErrorDeGemini` si no contesta bien. */
async function pedir(cuerpo: unknown): Promise<Contenido> {
  const clave = claveDeChat('gemini');
  if (!clave) throw new ErrorDeGemini('No hay clave de Gemini');

  const res = await fetch(`${RAIZ}/models/${config.geminiModel}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': clave },
    body: JSON.stringify(cuerpo),
  });

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new ErrorDeGemini(`Gemini contestó ${res.status}: ${detalle.slice(0, 300)}`);
  }

  const datos = (await res.json()) as {
    candidates?: Array<{ content?: Contenido; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
  };

  if (datos.promptFeedback?.blockReason) {
    throw new ErrorDeGemini(`Gemini bloqueó el mensaje (${datos.promptFeedback.blockReason})`);
  }

  const contenido = datos.candidates?.[0]?.content;
  if (!contenido) throw new ErrorDeGemini('Gemini contestó sin contenido');
  return contenido;
}

/**
 * Atiende un turno completo: pregunta, corre las herramientas que pida, y
 * vuelve a preguntar hasta que conteste con texto.
 */
export async function responderConGemini(opciones: {
  sistema: string;
  historia: Array<{ role: 'user' | 'assistant'; content: string }>;
  herramientas: ToolDefinition[];
  correr: (nombre: string, entrada: Record<string, unknown>) => unknown;
  maxRondas: number;
  maxTokens: number;
}): Promise<Resultado> {
  const contenidos: Contenido[] = opciones.historia.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const trace: Traza[] = [];

  for (let ronda = 0; ronda < opciones.maxRondas; ronda += 1) {
    const contenido = await pedir({
      systemInstruction: { parts: [{ text: opciones.sistema }] },
      contents: contenidos,
      tools: herramientasParaGemini(opciones.herramientas),
      generationConfig: { maxOutputTokens: opciones.maxTokens },
    });

    const llamadas = (contenido.parts ?? []).filter((p) => p.functionCall);

    if (!llamadas.length) {
      const texto = (contenido.parts ?? [])
        .map((p) => p.text ?? '')
        .join('\n')
        .trim();
      return { reply: texto || 'Perdón, no te entendí. ¿Me lo repetís?', trace };
    }

    // Lo que dijo el modelo va tal cual: si se recorta, pierde el hilo de qué
    // herramienta pidió y vuelve a pedirla.
    contenidos.push({ role: 'model', parts: contenido.parts });

    const respuestas: Parte[] = llamadas.map((p) => {
      const { name, args } = p.functionCall!;
      const salida = opciones.correr(name, args ?? {});
      trace.push({ tool: name, input: args ?? {}, output: salida });
      return {
        // Gemini aparea por NOMBRE, no por id: el nombre tiene que ser el
        // mismo que pidió o no encuentra la respuesta.
        functionResponse: {
          name,
          // Siempre un objeto: con un array o un texto suelto, Gemini rechaza
          // el turno entero.
          response: { resultado: salida },
        },
      };
    });

    contenidos.push({ role: 'user', parts: respuestas });
  }

  return {
    reply: 'Se me complicó procesar eso. ¿Me lo decís de nuevo, más simple?',
    trace,
  };
}

export interface PasoDelMotor {
  paso: string;
  ok: boolean;
  detalle: string;
  arreglo?: string;
}

/**
 * Revisa la conexión con Gemini y dice qué falta.
 *
 * Lo más útil que hace: LISTAR los modelos que esa clave puede usar. Los
 * nombres cambian seguido y el error de un modelo que no existe es un 404 que
 * no dice cuáles sí están.
 */
export async function probarGemini(): Promise<{ listo: boolean; pasos: PasoDelMotor[] }> {
  const pasos: PasoDelMotor[] = [];
  const clave = claveDeChat('gemini');

  pasos.push({
    paso: 'La clave está cargada',
    ok: Boolean(clave),
    detalle: clave ? 'Está' : 'No hay clave de Gemini',
    arreglo: clave ? undefined : 'Sacala de aistudio.google.com y cargala acá.',
  });
  if (!clave) return { listo: false, pasos };

  let modelos: string[] = [];
  try {
    const res = await fetch(`${RAIZ}/models`, { headers: { 'x-goog-api-key': clave } });
    const cuerpo = (await res.json().catch(() => ({}))) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
      error?: { message?: string };
    };

    if (res.ok) {
      modelos = (cuerpo.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => (m.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
      pasos.push({
        paso: 'Google acepta la clave',
        ok: true,
        detalle: `${modelos.length} modelos disponibles`,
      });
    } else {
      pasos.push({
        paso: 'Google acepta la clave',
        ok: false,
        detalle: cuerpo.error?.message ?? `Google contestó ${res.status}`,
        arreglo:
          res.status === 400 || res.status === 403
            ? 'Fijate que la clave sea de Gemini (aistudio.google.com) y que la API esté habilitada en ese proyecto.'
            : undefined,
      });
      return { listo: false, pasos };
    }
  } catch (err) {
    pasos.push({
      paso: 'Google acepta la clave',
      ok: false,
      detalle: err instanceof Error ? err.message : 'No se pudo llegar a Google',
      arreglo: 'El servidor tiene que poder salir a generativelanguage.googleapis.com.',
    });
    return { listo: false, pasos };
  }

  const elegido = config.geminiModel;
  const sirve = modelos.includes(elegido);
  pasos.push({
    paso: `El modelo "${elegido}" existe`,
    ok: sirve,
    detalle: sirve ? 'Se puede usar con esta clave' : 'Esa clave no lo tiene',
    arreglo: sirve
      ? undefined
      : `Poné GEMINI_MODEL con uno de estos: ${modelos.slice(0, 6).join(', ')}`,
  });

  return { listo: pasos.every((p) => p.ok), pasos };
}

// ── El motor, para el panel ─────────────────────────────────────────────────

/** Los dos proveedores, para guardarlos y para decir de dónde sale cada uno. */
export const CLAVES_DE_CHAT = [
  { campo: 'anthropic', variable: 'ANTHROPIC_API_KEY', guardada: 'chat.anthropic_api_key' },
  { campo: 'gemini', variable: 'GEMINI_API_KEY', guardada: 'chat.gemini_api_key' },
] as const;
