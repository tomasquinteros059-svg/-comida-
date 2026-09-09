import { useEffect, useRef } from 'react';
import { getAdminToken } from './api';

export type LiveEventType = 'pedido' | 'stock' | 'carta' | 'compras' | 'conocimiento';

export interface LiveEvent {
  type: LiveEventType;
  detail: string;
  at: string;
}

/**
 * Escucha los cambios del local por SSE y llama a `onEvent` cuando pasa algo
 * de los tipos pedidos.
 *
 * Es un complemento del polling, no un reemplazo: si la conexión se corta el
 * panel se sigue refrescando solo, apenas más lento.
 */
export function useLive(types: LiveEventType[], onEvent: (event: LiveEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const key = types.join(',');

  useEffect(() => {
    const token = getAdminToken();
    const source = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);

    const listeners = key.split(',').map((type) => {
      const listener = (event: MessageEvent) => {
        try {
          handler.current(JSON.parse(event.data) as LiveEvent);
        } catch {
          // Un mensaje mal formado no debe tirar abajo el stream.
        }
      };
      source.addEventListener(type, listener as EventListener);
      return [type, listener] as const;
    });

    return () => {
      for (const [type, listener] of listeners) source.removeEventListener(type, listener as EventListener);
      source.close();
    };
  }, [key]);
}
