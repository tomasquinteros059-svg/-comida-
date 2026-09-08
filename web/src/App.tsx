import { useEffect, useState } from 'react';
import { useApi } from './lib/useApi';
import type { Dashboard } from './lib/types';
import { DashboardPage } from './pages/Dashboard';
import { KitchenPage } from './pages/Kitchen';
import { ChatPage } from './pages/Chat';
import { MenuPage } from './pages/Menu';
import { StockPage } from './pages/Stock';
import { PurchasesPage } from './pages/Purchases';
import { BotPage } from './pages/Bot';

interface RouteDef {
  id: string;
  label: string;
  icon: string;
  section: string;
  render: () => JSX.Element;
}

const ROUTES: RouteDef[] = [
  { id: 'panel', label: 'Panel', icon: '◲', section: 'Hoy', render: () => <DashboardPage /> },
  { id: 'cocina', label: 'Cocina', icon: '▤', section: 'Hoy', render: () => <KitchenPage /> },
  { id: 'chat', label: 'Chatbot', icon: '◈', section: 'Hoy', render: () => <ChatPage /> },
  { id: 'carta', label: 'Carta', icon: '☰', section: 'Gestion', render: () => <MenuPage /> },
  { id: 'stock', label: 'Stock', icon: '◱', section: 'Gestion', render: () => <StockPage /> },
  { id: 'compras', label: 'Compras', icon: '⇄', section: 'Gestion', render: () => <PurchasesPage /> },
  { id: 'bot', label: 'Entrenar al bot', icon: '✦', section: 'Gestion', render: () => <BotPage /> },
];

const routeFromHash = () => {
  const id = window.location.hash.replace('#/', '') || 'panel';
  return ROUTES.some((r) => r.id === id) ? id : 'panel';
};

export function App() {
  const [route, setRoute] = useState(routeFromHash);
  const { data: dashboard } = useApi<Dashboard>('/dashboard', 30_000);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const current = ROUTES.find((r) => r.id === route) ?? ROUTES[0]!;

  const badges: Record<string, number> = {
    cocina: dashboard?.kitchen ?? 0,
    stock: (dashboard?.stock_alert_counts.agotado ?? 0) + (dashboard?.stock_alert_counts.critico ?? 0),
  };

  let lastSection = '';

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-name">
            come<span className="brand-dot">ya</span>
          </span>
          <span className="brand-sub">panel</span>
        </div>
        {ROUTES.map((r) => {
          const header = r.section !== lastSection ? r.section : null;
          lastSection = r.section;
          return (
            <div key={r.id}>
              {header && <div className="nav-section">{header}</div>}
              <a
                href={`#/${r.id}`}
                className={`nav-item${r.id === route ? ' active' : ''}`}
                aria-current={r.id === route ? 'page' : undefined}
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
        <header className="topbar">
          <h1>{current.label}</h1>
          <div className="topbar-actions">
            {dashboard && (
              <span className="small muted nowrap">
                {dashboard.open_orders} en curso · {dashboard.today.orders} pedidos hoy
              </span>
            )}
          </div>
        </header>
        <div className="content">{current.render()}</div>
      </main>
    </div>
  );
}
