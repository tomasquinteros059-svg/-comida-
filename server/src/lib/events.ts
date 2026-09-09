import type { Request, Response } from 'express';

/**
 * Bus de eventos del local. El panel y el chat se enteran de un cambio de
 * stock en el momento en que pasa, en vez de esperar al proximo refresco.
 *
 * Es deliberadamente un bus en memoria: un local corre un solo proceso. Si
 * algun dia hay varios, esto se cambia por Redis y los emisores no se tocan.
 */
export type EventType =
  | 'pedido'          // se creo o cambio de estado un pedido
  | 'stock'           // se movio stock (venta, compra, ajuste, merma)
  | 'carta'           // cambio la carta o la disponibilidad de un producto
  | 'compras'         // se armo, envio o recibio una orden de compra
  | 'conocimiento';   // cambio lo que el local le enseño al bot

export interface LocalEvent {
  type: EventType;
  detail?: string;
  at: string;
}

type Listener = (event: LocalEvent) => void;

const listeners = new Set<Listener>();

export function emit(type: EventType, detail = ''): void {
  const event: LocalEvent = { type, detail, at: new Date().toISOString() };
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('[events] listener fallo', err);
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Handler SSE: mantiene abierta la conexion y empuja cada evento. */
export function eventStream(req: Request, res: Response): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx no debe bufferear este stream
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');

  const unsubscribe = subscribe((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // Un comentario cada 25 s evita que un proxy corte la conexion por inactiva.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
}

/** Solo para tests: deja el bus sin oyentes. */
export const _resetListeners = () => listeners.clear();
