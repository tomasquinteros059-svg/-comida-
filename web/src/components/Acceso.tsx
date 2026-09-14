import { useState } from 'react';
import { api, ApiError, setAdminToken } from '../lib/api';
import type { Sesion } from '../lib/sesion';

type Modo = 'clave' | 'token';

/**
 * Pantalla de entrada al panel. Hace tres cosas distintas segun el estado del
 * servidor: crear el primer dueño en una instalación recién puesta, pedir
 * usuario y clave, o aceptar el token maestro como llave de repuesto para
 * cuando alguien se quedó afuera.
 */
export function Acceso({ sesion, expirada }: { sesion: Sesion; expirada: boolean }) {
  if (sesion.sinUsuarios) return <PrimerDueño conToken={sesion.conToken} />;
  return <Ingreso conToken={sesion.conToken} expirada={expirada} />;
}

function Ingreso({ conToken, expirada }: { conToken: boolean; expirada: boolean }) {
  const [modo, setModo] = useState<Modo>('clave');
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      if (modo === 'token') {
        setAdminToken(token.trim());
      } else {
        await api.post('/auth/login', { usuario: usuario.trim(), clave });
      }
      // Recargar es lo más simple y lo más seguro: todas las pantallas vuelven
      // a pedir sus datos con la sesión nueva, sin estado viejo dando vueltas.
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');
      setEnviando(false);
    }
  }

  const listo = modo === 'token' ? token.trim().length > 0 : usuario.trim() && clave.length > 0;

  return (
    <Caja>
      <h1 className="acceso-titulo">{expirada ? 'Se cerró la sesión' : 'Panel del local'}</h1>
      <p className="acceso-texto">
        {expirada
          ? 'La sesión venció o alguien la cerró desde otro lado. Entrá de nuevo.'
          : 'Entrá con tu usuario para ver lo que te corresponde según tu rol.'}
      </p>

      <form onSubmit={entrar}>
        {modo === 'clave' ? (
          <>
            <label className="field" style={{ marginTop: 18 }}>
              <span className="field-label">Usuario</span>
              <input
                className="input"
                value={usuario}
                onChange={(e) => setUsuario(e.target.value)}
                autoFocus
                autoComplete="username"
                placeholder="tu.nombre"
              />
            </label>
            <label className="field" style={{ marginTop: 10 }}>
              <span className="field-label">Clave</span>
              <input
                className="input"
                type="password"
                value={clave}
                onChange={(e) => setClave(e.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </label>
          </>
        ) : (
          <label className="field" style={{ marginTop: 18 }}>
            <span className="field-label">Token maestro</span>
            <input
              className="input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
              placeholder="el ADMIN_TOKEN del servidor"
            />
          </label>
        )}

        {error && <p className="acceso-error">{error}</p>}

        <button
          className="btn primary"
          type="submit"
          disabled={!listo || enviando}
          style={{ marginTop: 14, width: '100%' }}
        >
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>

      {conToken && (
        <button
          className="btn ghost small"
          style={{ marginTop: 10, width: '100%' }}
          onClick={() => {
            setError(null);
            setModo(modo === 'clave' ? 'token' : 'clave');
          }}
        >
          {modo === 'clave' ? 'Entrar con el token maestro' : 'Volver a usuario y clave'}
        </button>
      )}

      <p className="acceso-pie">
        ¿Olvidaste la clave? Pedísela a quien sea dueño del local: desde Usuarios
        te la puede cambiar. El chat de los clientes funciona sin clave.
      </p>
    </Caja>
  );
}

function PrimerDueño({ conToken }: { conToken: boolean }) {
  const [name, setName] = useState('');
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function crear(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await api.post('/auth/bootstrap', {
        name: name.trim(),
        usuario: usuario.trim(),
        clave,
        ...(conToken ? { token: token.trim() } : {}),
      });
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar con el servidor');
      setEnviando(false);
    }
  }

  const listo = name.trim() && usuario.trim().length >= 3 && clave.length >= 8 && (!conToken || token.trim());

  return (
    <Caja>
      <h1 className="acceso-titulo">Configurá el primer usuario</h1>
      <p className="acceso-texto">
        Este local todavía no tiene a nadie dado de alta. El primero es el dueño:
        ve todo y desde Usuarios da de alta al resto del equipo.
      </p>

      <form onSubmit={crear}>
        <label className="field" style={{ marginTop: 18 }}>
          <span className="field-label">Tu nombre</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ana Gómez" />
        </label>
        <label className="field" style={{ marginTop: 10 }}>
          <span className="field-label">Usuario</span>
          <input
            className="input"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            autoComplete="username"
            placeholder="ana"
          />
        </label>
        <label className="field" style={{ marginTop: 10 }}>
          <span className="field-label">Clave</span>
          <input
            className="input"
            type="password"
            value={clave}
            onChange={(e) => setClave(e.target.value)}
            autoComplete="new-password"
            placeholder="al menos 8 caracteres"
          />
        </label>
        {conToken && (
          <label className="field" style={{ marginTop: 10 }}>
            <span className="field-label">Token de instalación</span>
            <input
              className="input"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="el ADMIN_TOKEN del servidor"
            />
            <span className="field-hint">
              Se pide una sola vez: sin esto, el primero que encuentra la dirección
              se queda con el local.
            </span>
          </label>
        )}

        {error && <p className="acceso-error">{error}</p>}

        <button className="btn primary" type="submit" disabled={!listo || enviando} style={{ marginTop: 14, width: '100%' }}>
          {enviando ? 'Creando…' : 'Crear y entrar'}
        </button>
      </form>
    </Caja>
  );
}

const Caja = ({ children }: { children: React.ReactNode }) => (
  <div className="acceso">
    <div className="acceso-caja">
      <div className="brand-name" style={{ fontSize: '1.5rem' }}>
        come<span className="brand-accent">IA</span>
      </div>
      {children}
    </div>
  </div>
);
