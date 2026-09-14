import { useState } from 'react';
import { setAdminToken } from '../lib/api';

/**
 * Pantalla de acceso al panel.
 *
 * El servidor protege todo con una clave; sin esta pantalla la única forma de
 * cargarla era editar el almacenamiento del navegador a mano, y el panel se
 * veía vacío sin decir por qué.
 */
export function Acceso({ motivo }: { motivo: 'inicio' | 'expirado' }) {
  const [clave, setClave] = useState('');
  const [enviando, setEnviando] = useState(false);

  function entrar(event: React.FormEvent) {
    event.preventDefault();
    if (!clave.trim()) return;
    setEnviando(true);
    setAdminToken(clave.trim());
    // Recargar es lo más simple y lo más seguro: todas las pantallas vuelven a
    // pedir sus datos con la credencial nueva, sin estado viejo dando vueltas.
    window.location.reload();
  }

  return (
    <div className="acceso">
      <form className="acceso-caja" onSubmit={entrar}>
        <div className="brand-name" style={{ fontSize: '1.5rem' }}>
          come<span className="brand-accent">IA</span>
        </div>

        <h1 className="acceso-titulo">
          {motivo === 'expirado' ? 'La clave dejó de funcionar' : 'Panel del local'}
        </h1>
        <p className="acceso-texto">
          {motivo === 'expirado'
            ? 'El servidor rechazó la clave guardada. Puede que haya cambiado en el servidor; volvé a ingresarla.'
            : 'Ingresá la clave del local para entrar. Es la que está configurada como ADMIN_TOKEN en el servidor.'}
        </p>

        <label className="field" style={{ marginTop: 18 }}>
          <span className="field-label">Clave</span>
          <input
            className="input"
            type="password"
            value={clave}
            onChange={(event) => setClave(event.target.value)}
            autoFocus
            autoComplete="current-password"
            placeholder="••••••••••••"
          />
        </label>

        <button className="btn primary" type="submit" disabled={!clave.trim() || enviando} style={{ marginTop: 14, width: '100%' }}>
          Entrar
        </button>

        <p className="acceso-pie">
          Queda guardada en este dispositivo. El chat de los clientes funciona sin
          clave: esto protege solo la gestión del local.
        </p>
      </form>
    </div>
  );
}
