import { claveDeChat, config, proveedorDeChat } from '../config.js';
import { CLAVES_DE_CHAT, probarGemini, type PasoDelMotor } from '../chat/gemini.js';
import { guardarSecreto, hayGuardado, sePuedeGuardar } from '../domain/secretos.js';
import { badRequest } from '../lib/http.js';

/**
 * El motor que entiende los pedidos.
 *
 * Sin clave el bot usa el motor determinista: entiende con reglas y
 * coincidencia difusa. Alcanza para "quiero 6 empanadas" y se pierde con
 * "sacale la cebolla a dos de las cuatro". Con clave, entiende de verdad.
 *
 * Se puede elegir entre Anthropic y Gemini: los dos hacen lo mismo acá y
 * llaman a las mismas herramientas. Se carga una y listo.
 */

export const estadoDelMotor = () => {
  const origen: Record<string, 'entorno' | 'panel' | 'falta'> = {};
  for (const { campo, variable, guardada } of CLAVES_DE_CHAT) {
    if (process.env[variable]?.trim()) origen[campo] = 'entorno';
    else if (hayGuardado(guardada)) origen[campo] = 'panel';
    else origen[campo] = 'falta';
  }

  const usando = proveedorDeChat();
  return {
    usando,
    // El nombre del modelo no es un secreto y ayuda a entender qué contesta.
    modelo: usando === 'gemini' ? config.geminiModel : usando === 'anthropic' ? config.chatModel : '',
    origen,
    se_puede_cargar: sePuedeGuardar(),
  };
};

/** Guarda las claves que cargaron en el panel. Nunca devuelve lo guardado. */
export function guardarClavesDelMotor(body: unknown) {
  if (!sePuedeGuardar()) {
    throw badRequest('Falta ADMIN_TOKEN en el servidor: sin eso no hay con qué cifrar la clave');
  }
  const entrada = (body ?? {}) as Record<string, unknown>;
  for (const { campo, guardada } of CLAVES_DE_CHAT) {
    const valor = entrada[campo];
    if (typeof valor === 'string') guardarSecreto(guardada, valor);
  }
  return estadoDelMotor();
}

/**
 * Revisa que el motor configurado conteste.
 *
 * Con Gemini se le pregunta a Google qué modelos tiene esa clave, que es lo
 * que de verdad se necesita: los nombres cambian seguido y un modelo que no
 * existe da un 404 que no dice cuáles sí están.
 */
export async function probarElMotor(): Promise<{ listo: boolean; pasos: PasoDelMotor[] }> {
  const usando = proveedorDeChat();

  if (usando === 'ninguno') {
    return {
      listo: false,
      pasos: [{
        paso: 'Hay una clave cargada',
        ok: false,
        detalle: 'El bot está contestando con el motor determinista',
        arreglo:
          'Cargá una clave de Gemini (aistudio.google.com) o de Anthropic. Sin eso ' +
          'el bot entiende con reglas: toma pedidos simples y se pierde con los enredados.',
      }],
    };
  }

  if (usando === 'gemini') return probarGemini();

  // Anthropic: alcanza con pedirle la lista de modelos, que es barato y dice
  // si la clave sirve.
  const pasos: PasoDelMotor[] = [];
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': claveDeChat('anthropic'), 'anthropic-version': '2023-06-01' },
    });
    if (res.ok) {
      pasos.push({ paso: 'Anthropic acepta la clave', ok: true, detalle: `modelo: ${config.chatModel}` });
    } else {
      const cuerpo = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      pasos.push({
        paso: 'Anthropic acepta la clave',
        ok: false,
        detalle: cuerpo.error?.message ?? `Contestó ${res.status}`,
        arreglo: res.status === 401 ? 'Revisá la clave en console.anthropic.com.' : undefined,
      });
    }
  } catch (err) {
    pasos.push({
      paso: 'Anthropic acepta la clave',
      ok: false,
      detalle: err instanceof Error ? err.message : 'No se pudo llegar',
      arreglo: 'El servidor tiene que poder salir a api.anthropic.com.',
    });
  }
  return { listo: pasos.every((p) => p.ok), pasos };
}
