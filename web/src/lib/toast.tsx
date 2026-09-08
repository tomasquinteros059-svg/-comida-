import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
}

const ToastContext = createContext<{
  notify: (text: string, tone?: Toast['tone']) => void;
}>({ notify: () => {} });

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4500);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-tray">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`} role="status">
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Ejecuta una accion y avisa por toast si falla. Devuelve true si salio bien. */
export function useAction() {
  const { notify } = useToast();
  return useCallback(
    async (action: () => Promise<unknown>, successText?: string): Promise<boolean> => {
      try {
        await action();
        if (successText) notify(successText, 'ok');
        return true;
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Algo salio mal', 'error');
        return false;
      }
    },
    [notify],
  );
}
