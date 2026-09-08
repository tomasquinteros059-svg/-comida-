import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

interface State<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Carga un endpoint y lo refresca cada `pollMs` si se indica.
 * Devuelve `reload` para refrescar a mano despues de una mutacion.
 */
export function useApi<T>(path: string | null, pollMs?: number) {
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: !!path });
  const mounted = useRef(true);

  const load = useCallback(
    async (quiet = false) => {
      if (!path) return;
      if (!quiet) setState((s) => ({ ...s, loading: true }));
      try {
        const data = await api.get<T>(path);
        if (mounted.current) setState({ data, error: null, loading: false });
      } catch (err) {
        if (mounted.current) {
          setState((s) => ({
            data: s.data,
            error: err instanceof Error ? err.message : 'Error de red',
            loading: false,
          }));
        }
      }
    },
    [path],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!pollMs || !path) return;
    const id = setInterval(() => void load(true), pollMs);
    return () => clearInterval(id);
  }, [pollMs, path, load]);

  return { ...state, reload: () => load(true) };
}
