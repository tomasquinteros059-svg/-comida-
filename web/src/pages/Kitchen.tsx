import { useEffect, useState } from 'react';
import { useApi } from '../lib/useApi';
import { useLive } from '../lib/useLive';
import { api } from '../lib/api';
import { useAction } from '../lib/toast';
import type { Order } from '../lib/types';
import { Badge, Card, Empty, Modal, Spinner } from '../components/ui';
import { SERVICE_LABEL, STATUS_LABEL, money, parseDate, stamp } from '../lib/format';

const NEXT_STATUS: Record<string, { status: string; label: string }> = {
  confirmado: { status: 'en_preparacion', label: 'Empezar' },
  en_preparacion: { status: 'listo', label: 'Listo' },
  listo: { status: 'entregado', label: 'Entregado' },
};

/**
 * Minutos desde que entró el pedido. Nunca negativo: si el reloj del servidor
 * va adelantado respecto del navegador, un pedido recién entrado daría un
 * número negativo y la comanda mostraría "-3 min".
 */
const elapsedMinutes = (order: Order) =>
  Math.max(0, Math.floor((Date.now() - parseDate(order.created_at).getTime()) / 60_000));

export function KitchenPage() {
  const { data, loading, error, reload } = useApi<Order[]>('/orders/kitchen', 8_000);
  const run = useAction();
  useLive(['pedido'], () => void reload());
  const [ticket, setTicket] = useState<{ code: string; text: string } | null>(null);
  const [, forceTick] = useState(0);

  // Los relojes de cada comanda se refrescan solos aunque no lleguen datos.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const advance = (order: Order, status: string) =>
    void run(async () => {
      await api.post(`/orders/${order.id}/status`, { status, actor: 'cocina' });
      await reload();
    });

  const openTicket = (order: Order) =>
    void run(async () => {
      const text = await fetch(`/api/orders/${order.id}/ticket`).then((r) => r.text());
      setTicket({ code: `#${String(order.daily_number).padStart(3, '0')}`, text });
    });

  if (error) return <div className="banner danger">No pude cargar la cocina: {error}</div>;
  if (!data) return loading ? <Spinner /> : null;

  const groups = [
    { status: 'confirmado', title: 'En espera' },
    { status: 'en_preparacion', title: 'Cocinando' },
    { status: 'listo', title: 'Para entregar' },
  ];

  return (
    <div className="stack">
      {!data.length && <Empty icon="✓">No hay pedidos en curso. Cocina despejada.</Empty>}

      {groups.map((group) => {
        const orders = data.filter((o) => o.status === group.status);
        if (!orders.length) return null;
        return (
          <div key={group.status} className="stack tight">
            <div className="row">
              <h2>{group.title}</h2>
              <Badge tone={group.status === 'listo' ? 'ok' : 'neutral'}>{orders.length}</Badge>
            </div>
            <div className="kds">
              {orders.map((order) => {
                const minutes = elapsedMinutes(order);
                const target = Math.ceil((order.prep_seconds ?? 600) / 60);
                const late = minutes > target && order.status !== 'listo';
                const next = NEXT_STATUS[order.status];
                return (
                  <article className="ticket" data-status={order.status} data-late={late} key={order.id}>
                    <header className="ticket-head">
                      <span className="ticket-number">
                        #{String(order.daily_number).padStart(3, '0')}
                      </span>
                      <Badge tone={order.service_type === 'delivery' ? 'info' : 'neutral'}>
                        {SERVICE_LABEL[order.service_type] ?? order.service_type}
                        {order.table_label ? ` · mesa ${order.table_label}` : ''}
                      </Badge>
                      <span className={`ticket-time${late ? ' late' : ''}`}>
                        {minutes} min
                      </span>
                    </header>

                    <div className="ticket-items">
                      {order.items.map((item) => (
                        <div key={item.id}>
                          <div className="ticket-line">
                            <span className="ticket-qty">{item.qty}×</span>
                            <span>{item.product_name}</span>
                          </div>
                          {item.modifiers.map((mod) => (
                            <div className="ticket-mod" key={mod.id}>+ {mod.name}</div>
                          ))}
                          {item.note && <div className="ticket-note">! {item.note}</div>}
                        </div>
                      ))}
                      {order.note && <div className="ticket-note">! {order.note}</div>}
                    </div>

                    <footer className="ticket-foot">
                      {next && (
                        <button className="btn primary small" onClick={() => advance(order, next.status)}>
                          {next.label}
                        </button>
                      )}
                      <button className="btn small" onClick={() => openTicket(order)}>
                        Comanda
                      </button>
                      <button
                        className="btn ghost small danger"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => advance(order, 'cancelado')}
                        title="Cancelar y devolver los insumos al stock"
                      >
                        ✕
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>
          </div>
        );
      })}

      <RecentOrders />

      {ticket && (
        <Modal
          title={`Comanda ${ticket.code}`}
          onClose={() => setTicket(null)}
          footer={
            <button className="btn" onClick={() => window.print()}>
              Imprimir
            </button>
          }
        >
          <pre className="trace" style={{ maxHeight: 420 }}>{ticket.text}</pre>
        </Modal>
      )}
    </div>
  );
}

function RecentOrders() {
  const { data } = useApi<Order[]>('/orders?status=entregado,cancelado&limit=12', 30_000);
  if (!data?.length) return null;
  return (
    <Card title="Cerrados recientemente" tight>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Hora</th>
              <th>Canal</th>
              <th>Detalle</th>
              <th className="num">Total</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {data.map((order) => (
              <tr key={order.id}>
                <td className="mono">{String(order.daily_number).padStart(3, '0')}</td>
                <td className="nowrap">{stamp(order.created_at)}</td>
                <td><Badge tone={order.channel === 'chat' ? 'accent' : 'neutral'}>{order.channel}</Badge></td>
                <td className="small muted">
                  {order.items.map((i) => `${i.qty}× ${i.product_name}`).join(', ') || '—'}
                </td>
                <td className="num">{money(order.total_cents)}</td>
                <td>
                  <Badge tone={order.status === 'entregado' ? 'ok' : 'danger'}>
                    {STATUS_LABEL[order.status] ?? order.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
