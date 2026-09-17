/**
 * Una cola por clave, para el trabajo que se dispara sin esperarlo.
 *
 * El caso que la trajo: los avisos al cliente por WhatsApp. Se disparan sin
 * await desde el cambio de estado —la cocina no se frena por un mensaje— así
 * que dos seguidos corren en paralelo y compiten. El cliente puede recibir
 * "ya está listo" ANTES que "tomamos tu pedido", y entonces cree que le
 * contestaron a otro. Pasa cuando alguien toca dos botones seguidos.
 *
 * Lo importante es que `enFila` sea SINCRÓNICA: encola en el momento en que
 * se la llama. Si el encolado quedara detrás de un `await` —por ejemplo un
 * `import()` dinámico— el orden lo terminaría decidiendo cuál de esos awaits
 * resuelve primero, que es exactamente lo que se quiere evitar.
 *
 * Las claves distintas no se esperan entre sí: dos pedidos siguen avanzando
 * en paralelo.
 */

const colas = new Map<string, Promise<unknown>>();

export function enFila<T>(clave: string, tarea: () => Promise<T>): Promise<T> {
  const anterior = colas.get(clave) ?? Promise.resolve();
  // `then(tarea, tarea)` y no `then(tarea)`: si el anterior falló, el que
  // sigue tiene que correr igual. Si no, un error deja la cola trabada.
  const siguiente = anterior.then(tarea, tarea);

  colas.set(clave, siguiente);
  // Se limpia cuando no quedó nadie atrás, para que el Map no termine con una
  // entrada por cada pedido del día.
  void siguiente.catch(() => {}).finally(() => {
    if (colas.get(clave) === siguiente) colas.delete(clave);
  });

  return siguiente;
}

/** Cuántas colas hay abiertas. Para los tests: si esto crece, hay una fuga. */
export const colasAbiertas = (): number => colas.size;
