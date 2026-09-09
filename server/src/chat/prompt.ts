import { allSettings } from '../db/index.js';
import { config } from '../config.js';
import { listProducts, menuAsText } from '../domain/menu.js';
import { orderableNow } from '../domain/stock.js';
import { knowledgeAsText } from '../domain/knowledge.js';

export interface SystemPrompt {
  /**
   * Lo que no cambia entre turnos: reglas, carta y conocimiento. Va antes del
   * punto de cache, asi el modelo no vuelve a cobrarlo en cada mensaje.
   */
  stable: string;
  /**
   * Lo que cambia mientras el cliente escribe: que se acabo recien. Va despues
   * del punto de cache, porque un solo byte distinto invalida todo lo que
   * sigue, y no queremos que una venta tire abajo el cache de la carta entera.
   */
  volatile: string;
}

/**
 * Arma el system prompt. Se reconstruye en cada turno a proposito: la carta, el
 * stock y el conocimiento cambian desde el panel mientras el cliente escribe, y
 * el bot tiene que verlo en el mensaje siguiente.
 *
 * Viene partido en dos para que el cache sirva. El prefijo estable son ~2400
 * tokens que se reenvian en cada llamada; cachearlos los cobra a una decima
 * parte. Si la disponibilidad estuviera mezclada ahi adentro, cada venta
 * invalidaria el cache y no se ahorraria nada.
 */
export function buildSystemPrompt(conversationId?: string): SystemPrompt {
  const settings = allSettings();
  const localName = settings.nombre_local || 'el local';
  const orderable = orderableNow(conversationId);
  // La carta estable se escribe sin marcas de stock: incluye todo lo que esta
  // en la carta, y lo que hoy no hay se aclara aparte.
  const menu = menuAsText({ includeUnavailable: true, showAvailability: false });
  const knowledge = knowledgeAsText();

  const sinStock = listProducts({ onlyActive: true })
    .filter((product) => !orderable.get(product.id))
    .map((product) => product.name);

  const volatile = sinStock.length
    ? `## HOY NO HAY\nEstos platos estan en la carta pero no se pueden vender ahora. No los ofrezcas; si el cliente los pide, avisale y proponele una alternativa concreta:\n${sinStock.map((name) => `- ${name}`).join('\n')}`
    : '## HOY NO HAY\nHoy esta todo disponible.';

  const stable = `Sos el asistente de pedidos de ${localName}. Atendes por chat y tu trabajo es
tomar el pedido completo, sin errores, y dejarlo listo para cocina.

## Como hablas
- Español rioplatense, de vos. Cordial y directo, como alguien del mostrador.
- Respuestas cortas: dos o tres frases. Nada de listas largas salvo que te pidan la carta.
- Nunca inventes productos, precios, promociones ni tiempos de entrega.

## Reglas duras
1. Solo existe lo que esta en la CARTA de abajo. Si no esta, no lo tenemos.
2. Antes de agregar algo al pedido usa "buscar_en_carta" para obtener el id real.
   Nunca inventes ids.
3. Los precios salen de las herramientas, no de tu memoria.
4. Si el cliente pide algo sin stock o que no vendemos, llama a
   "registrar_pedido_no_disponible" y recien ahi ofrece una alternativa concreta.
5. Antes de confirmar, repeti el pedido completo con el total y espera un "si".
6. Para delivery necesitas direccion; para mesa, el numero de mesa. Pedilos con
   "datos_del_pedido" antes de confirmar.
7. Cuando el cliente confirma, llama a "confirmar_pedido" y decile el numero de
   pedido y la demora estimada.
8. Si algo falla, decilo con naturalidad y ofrece una salida. No pidas disculpas
   tres veces.

## Moneda
Los importes van en ${config.currency}, con el formato que devuelven las herramientas.

## CARTA
${menu}
${knowledge ? `\n## INFORMACION DEL LOCAL\n${knowledge}` : ''}`;

  return { stable, volatile };
}
