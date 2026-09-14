import { useEffect, useState } from 'react';
import { useApi } from '../lib/useApi';
import { useLive } from '../lib/useLive';
import { api } from '../lib/api';
import { useAction } from '../lib/toast';
import type { Order, Pagina } from '../lib/types';
import { Badge, Card, Empty, Field, Modal, Spinner, Switch } from '../components/ui';
import { SERVICE_LABEL, STATUS_LABEL, money, parseDate, stamp } from '../lib/format';
import { usePermiso } from '../lib/sesionContext';

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
  // Si no hay comandera configurada, el botón de imprimir no aparece: un botón
  // que siempre falla es peor que no tenerlo.
  const comandera = useApi<{ host: string; automatica: boolean }>('/orders/comandera/config');
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

  /** Manda la comanda a la impresora térmica de la cocina. */
  const imprimir = (order: Order) =>
    void run(async () => {
      const r = await api.post<{ impreso: boolean; motivo?: string }>(`/orders/${order.id}/imprimir`);
      if (!r.impreso) throw new Error(r.motivo ?? 'No se pudo imprimir');
      return r;
    }, `Comanda #${String(order.daily_number).padStart(3, '0')} impresa`);

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
                      {comandera.data?.host ? (
                        <button
                          className="btn small"
                          onClick={() => imprimir(order)}
                          title={`Imprimir en ${comandera.data.host}`}
                        >
                          Imprimir
                        </button>
                      ) : null}
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
      <ConfigComandera />

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

/**
 * Dónde está la comandera de la cocina. Es una impresora térmica de red: tiene
 * una IP fija en el router del local y escucha en el 9100, que es el puerto que
 * usan todas.
 */
function ConfigComandera() {
  const { data, reload } = useApi<{ host: string; puerto: number; automatica: boolean; copias: number }>(
    '/orders/comandera/config',
  );
  const run = useAction();
  const [host, setHost] = useState<string | null>(null);

  if (!data) return null;
  const valor = host ?? data.host;

  const guardar = (cambio: Record<string, unknown>) =>
    void run(async () => {
      await api.put('/orders/comandera/config', cambio);
      setHost(null);
      await reload();
    }, 'Guardado');

  return (
    <Card title="Comandera de la cocina">
      <p className="small muted" style={{ marginBottom: 14, maxWidth: '42rem' }}>
        La dirección de la impresora térmica en la red del local. En automático,
        la comanda sale sola apenas se confirma un pedido, sin que nadie tenga
        que estar mirando la pantalla.
      </p>

      <div className="filtros" style={{ marginBottom: 12 }}>
        <Field label="Dirección" hint="La IP fija que le diste en el router.">
          <input
            id="comandera-host"
            className="input"
            value={valor}
            placeholder="192.168.1.87"
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Field label="Puerto" hint="9100 en casi todas.">
          <input
            id="comandera-puerto"
            className="input"
            type="number"
            defaultValue={data.puerto}
            onBlur={(e) => guardar({ puerto: Number(e.target.value) })}
          />
        </Field>
        <Field label="Copias" hint="Una para la plancha, otra para el pase.">
          <input
            id="comandera-copias"
            className="input"
            type="number"
            min={1}
            max={5}
            defaultValue={data.copias}
            onBlur={(e) => guardar({ copias: Number(e.target.value) })}
          />
        </Field>
        <button className="btn primary small" disabled={host === null} onClick={() => guardar({ host: valor })}>
          Guardar
        </button>
      </div>

      <div className="row tight" style={{ alignItems: 'center', gap: 10 }}>
        <Switch
          on={data.automatica}
          onChange={(next) => guardar({ automatica: next })}
          label="Imprimir sola al confirmar un pedido"
        />
        <span className="small">Imprimir sola al confirmar un pedido</span>
      </div>

      {!data.host && (
        <p className="small muted" style={{ marginTop: 12 }}>
          Sin dirección cargada no aparece el botón de imprimir: un botón que
          siempre falla es peor que no tenerlo.
        </p>
      )}
    </Card>
  );
}

function RecentOrders() {
  const { data } = useApi<Pagina<Order>>('/orders?status=entregado,cancelado&limite=12', 30_000);
  // La cocina no ve facturacion: el tablero le sirve igual sin la columna de
  // plata, y esa es justamente la parte que no le corresponde.
  const conPlata = usePermiso('ventas');

  if (!data?.items.length) return null;
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
              {conPlata && <th className="num">Total</th>}
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((order) => (
              <tr key={order.id}>
                <td className="mono">{String(order.daily_number).padStart(3, '0')}</td>
                <td className="nowrap">{stamp(order.created_at)}</td>
                <td><Badge tone={order.channel === 'chat' ? 'accent' : 'neutral'}>{order.channel}</Badge></td>
                <td className="small muted">
                  {order.items.map((i) => `${i.qty}× ${i.product_name}`).join(', ') || '—'}
                </td>
                {conPlata && <td className="num">{money(order.total_cents)}</td>}
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
