import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Field, Modal } from './ui';

/**
 * Cambiarse la clave uno mismo, sin depender de que aparezca el dueño.
 * Pide la actual aunque la sesión esté abierta: si no, cualquiera que
 * encuentre una pantalla sin bloquear se queda con la cuenta.
 */
export function CambiarClave({ onClose }: { onClose: () => void }) {
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetida, setRepetida] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [listo, setListo] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const coinciden = nueva.length > 0 && nueva === repetida;
  const puede = actual.length > 0 && nueva.length >= 8 && coinciden && !enviando;

  async function guardar() {
    setError(null);
    setEnviando(true);
    try {
      await api.post('/auth/clave', { actual, nueva });
      setListo(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');
    } finally {
      setEnviando(false);
    }
  }

  if (listo) {
    return (
      <Modal
        title="Clave cambiada"
        onClose={onClose}
        footer={
          <button className="btn primary" onClick={onClose}>
            Listo
          </button>
        }
      >
        <p>
          Ya está. Se cerraron las sesiones que tenías abiertas en otros
          dispositivos: en este seguís adentro.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Cambiar mi clave"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!puede} onClick={() => void guardar()}>
          {enviando ? 'Guardando…' : 'Cambiar'}
        </button>
      }
    >
      <Field label="Clave actual">
        <input
          id="clave-actual"
          className="input"
          type="password"
          value={actual}
          onChange={(e) => setActual(e.target.value)}
          autoComplete="current-password"
          autoFocus
        />
      </Field>
      <Field label="Clave nueva" hint="Al menos 8 caracteres.">
        <input
          id="clave-nueva"
          className="input"
          type="password"
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field label="Repetila" hint={repetida && !coinciden ? 'No coincide con la de arriba.' : undefined}>
        <input
          id="clave-repetida"
          className="input"
          type="password"
          value={repetida}
          onChange={(e) => setRepetida(e.target.value)}
          autoComplete="new-password"
        />
      </Field>

      {error && <p className="acceso-error">{error}</p>}

      <p className="small muted" style={{ marginTop: 10 }}>
        Cambiarla cierra las sesiones abiertas en otros dispositivos.
      </p>
    </Modal>
  );
}
