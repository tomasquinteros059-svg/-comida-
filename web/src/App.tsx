import { useCallback, useEffect, useState } from 'react';
import { useApi } from './lib/useApi';
import { api, clearAdminToken, ES_DEMO, onUnauthorized } from './lib/api';
import { Acceso } from './components/Acceso';
import { CambiarClave } from './components/CambiarClave';
import { Spinner } from './components/ui';
import { leerSesion, type Permiso, type Sesion } from './lib/sesion';
import { ProveedorDeSesion } from './lib/sesionContext';
import { useLive } from './lib/useLive';
import type { Dashboard } from './lib/types';
import { DashboardPage } from './pages/Dashboard';
import { KitchenPage } from './pages/Kitchen';
import { ChatPage } from './pages/Chat';
import { MenuPage } from './pages/Menu';
import { StockPage } from './pages/Stock';
import { PurchasesPage } from './pages/Purchases';
import { BotPage } from './pages/Bot';
import { UsuariosPage } from './pages/Usuarios';
import { CajaPage } from './pages/Caja';
import { LocalesPage } from './pages/Locales';

interface RouteDef {
  id: string;
  label: string;
  icon: string;
  section: string;
  /** Permiso que hace falta para verla. La navegación se arma con esto. */
  permiso: Permiso;
  render: (sesion: Sesion) => JSX.Element;
}

const ROUTES: RouteDef[] = [
  { id: 'panel', label: 'Panel', icon: '◲', section: 'Hoy', permiso: 'ventas', render: () => <DashboardPage /> },
  { id: 'cocina', label: 'Cocina', icon: '▤', section: 'Hoy', permiso: 'cocina', render: () => <KitchenPage /> },
  { id: 'caja', label: 'Caja', icon: '◫', section: 'Hoy', permiso: 'ventas', render: () => <CajaPage /> },
  { id: 'chat', label: 'Chatbot', icon: '◈', section: 'Hoy', permiso: 'bot', render: () => <ChatPage /> },
  { id: 'carta', label: 'Carta', icon: '☰', section: 'Gestión', permiso: 'carta', render: () => <MenuPage /> },
  { id: 'stock', label: 'Stock', icon: '◱', section: 'Gestión', permiso: 'stock', render: () => <StockPage /> },
  { id: 'compras', label: 'Compras', icon: '⇄', section: 'Gestión', permiso: 'compras', render: () => <PurchasesPage /> },
  { id: 'bot', label: 'Entrenar al bot', icon: '✦', section: 'Gestión', permiso: 'bot', render: () => <BotPage /> },
  {
    id: 'usuarios',
    label: 'Usuarios',
    icon: '◍',
    section: 'Gestión',
    permiso: 'usuarios',
    render: (sesion) => <UsuariosPage yo={sesion.usuario?.id ?? null} />,
  },
  {
    id: 'locales',
    label: 'Locales',
    icon: '⌂',
    section: 'Gestión',
    permiso: 'usuarios',
    render: () => <LocalesPage />,
  },
];

export function App() {
  const [sesion, setSesion] = useState<Sesion | null>(null);
  // `expirada` distingue "nunca entré" de "la sesión que tenía dejó de servir":
  // son dos situaciones distintas y merecen dos mensajes distintos.
  const [expirada, setExpirada] = useState(false);

  useEffect(() => {
    onUnauthorized(() => setExpirada(true));
    void leerSesion()
      .then(setSesion)
      .catch(() => setSesion({ autenticado: false, sinUsuarios: false, conToken: true }));
  }, []);

  if (!sesion) return <div className="acceso"><Spinner /></div>;
  if (!sesion.autenticado || expirada) return <Acceso sesion={sesion} expirada={expirada} />;

  return (
    <ProveedorDeSesion sesion={sesion}>
      <Panel sesion={sesion} />
    </ProveedorDeSesion>
  );
}

function Panel({ sesion }: { sesion: Sesion }) {
  const [cambiandoClave, setCambiandoClave] = useState(false);
  const permisos = sesion.permisos ?? [];
  const visibles = ROUTES.filter((r) => permisos.includes(r.permiso));

  const routeFromHash = useCallback(() => {
    const id = window.location.hash.replace('#/', '');
    return visibles.some((r) => r.id === id) ? id : (visibles[0]?.id ?? '');
    // `visibles` se recalcula en cada render pero depende solo de los permisos,
    // que no cambian mientras la sesión esté abierta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permisos.join(',')]);

  const [route, setRoute] = useState(routeFromHash);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [routeFromHash]);

  // Los contadores del menú salen del panel, que no todos pueden ver: quien no
  // tiene el permiso simplemente no los pide, en vez de comerse un 403.
  const { data: dashboard, reload: reloadDashboard } = useApi<Dashboard>(
    permisos.includes('ventas') ? '/dashboard' : null,
    30_000,
  );
  useLive(['pedido', 'stock', 'carta'], () => void reloadDashboard());

  const current = visibles.find((r) => r.id === route) ?? visibles[0];

  const badges: Record<string, number> = {
    cocina: dashboard?.kitchen ?? 0,
    stock: (dashboard?.stock_alert_counts.agotado ?? 0) + (dashboard?.stock_alert_counts.critico ?? 0),
  };

  let lastSection = '';

  if (!current) {
    return (
      <div className="acceso">
        <div className="acceso-caja">
          <h1 className="acceso-titulo">Sin pantallas asignadas</h1>
          <p className="acceso-texto">
            Tu usuario no tiene ningún permiso cargado. Pedile a quien sea dueño del
            local que te revise el rol.
          </p>
          <button className="btn ghost" style={{ marginTop: 14 }} onClick={salir}>
            Salir
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-name">
            come<span className="brand-accent">IA</span>
          </span>
          <span className="brand-sub">panel</span>
        </div>
        {visibles.map((r) => {
          const header = r.section !== lastSection ? r.section : null;
          lastSection = r.section;
          return (
            <div key={r.id} className={`nav-grupo${header ? ' arranca' : ''}`}>
              {header && <div className="nav-section">{header}</div>}
              <a
                href={`#/${r.id}`}
                className={`nav-item${r.id === current.id ? ' active' : ''}`}
                aria-current={r.id === current.id ? 'page' : undefined}
              >
                <span className="nav-icon" aria-hidden>{r.icon}</span>
                {r.label}
                {badges[r.id] ? <span className="nav-count">{badges[r.id]}</span> : null}
              </a>
            </div>
          );
        })}
      </nav>

      <main className="main">
        {ES_DEMO && (
          <div className="cinta-demo">
            <strong>Demo</strong> · rotisería de ejemplo, todo corre en tu teléfono.
            Los pedidos que tomes son de mentira y se borran al recargar.
          </div>
        )}
        <header className="topbar">
          <h1>{current.label}</h1>
          <div className="topbar-actions">
            {dashboard && (
              <span className="small muted nowrap">
                {dashboard.open_orders} en curso · {dashboard.today.orders} pedidos hoy
              </span>
            )}
            {sesion.usuario?.viaToken ? (
              <span className="small muted nowrap">token maestro</span>
            ) : (
              <button
                className="btn ghost small"
                title="Cambiar mi clave"
                onClick={() => setCambiandoClave(true)}
              >
                {sesion.usuario?.name} · {sesion.usuario?.role}
              </button>
            )}
            <button className="btn ghost small" title="Cerrar la sesión" onClick={salir}>
              Salir
            </button>
          </div>
        </header>
        <div className="content">{current.render(sesion)}</div>
      </main>
      {cambiandoClave && <CambiarClave onClose={() => setCambiandoClave(false)} />}
    </div>
  );
}

/** Cierra la sesión en el servidor y olvida el token maestro del dispositivo. */
async function salir() {
  try {
    await api.post('/auth/logout');
  } catch {
    // Si el servidor no contesta igual conviene olvidar la credencial local.
  }
  clearAdminToken();
  window.location.reload();
}
