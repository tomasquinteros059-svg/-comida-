import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAction } from '../lib/toast';
import { useLive } from '../lib/useLive';
import { Badge, Card, Empty, Modal, Spinner } from '../components/ui';
import { money, stamp } from '../lib/format';

const MEDIOS = ['efectivo', 'debito', 'credito', 'transferencia', 'mercadopago', 'otro'] as const;
type Medio = (typeof MEDIOS)[number];

const ETIQUETA: Record<string, string> = {
  efectivo: 'Efectivo',
  debito: 'Débito',
  credito: 'Crédito',
  transferencia: 'Transferencia',
  mercadopago: 'Mercado Pago',
  otro: 'Otro',
  '': 'Sin medio',
};

interface Pendiente {
  id: string;
  code: string;
  daily_number: number;
  total_cents: number;
  created_at: string;
  channel: string;
}

interface Caja {
  fecha: string;
  por_medio: Array<{ payment_method: string; pedidos: number; total_cents: number }>;
  cobrado_cents: number;
  sin_cobrar_cents: number;
  sin_cobrar: number;
}

/**
 * Cobrar y cerrar la caja.
 *
 * La mayoría de lo que pasa en un mostrador no necesita ninguna integración:
 * alguien pagó en efectivo y se registra. El link de Mercado Pago es para el
 * que pide por el chat y paga antes de pasar a buscarlo.
 */
export function CajaPage() {
  const pendientes = useApi<{ pedidos: Pendiente[]; total_cents: number }>('/cobros/pendientes', 20_000);
  const caja = useApi<Caja>('/cobros/caja', 30_000);
  const estado = useApi<{ mercadopago: { activo: boolean; falta: string[] } }>('/cobros/estado');
  const ejecutar = useAction();
  const [cobrando, setCobrando] = useState<Pendiente | null>(null);
  const [link, setLink] = useState<{ pedido: string; url: string } | null>(null);

  useLive(['pedido'], () => {
    void pendientes.reload();
    void caja.reload();
  });

  const refrescar = () => {
    void pendientes.reload();
    void caja.reload();
  };

  const cobrar = (pedido: Pendiente, medio: Medio) =>
    void ejecutar(async () => {
      await api.post(`/cobros/pedido/${pedido.id}/pagado`, { medio });
      setCobrando(null);
      refrescar();
    }, `#${String(pedido.daily_number).padStart(3, '0')} cobrado`);

  const pedirLink = (pedido: Pendiente) =>
    void ejecutar(async () => {
      const r = await api.post<{ link: string }>(`/cobros/pedido/${pedido.id}/link`);
      setLink({ pedido: `#${String(pedido.daily_number).padStart(3, '0')}`, url: r.link });
      refrescar();
      return r;
    });

  if (!pendientes.data || !caja.data) return <Spinner />;

  return (
    <div className="stack">
      <div className="grid cols-2">
        <Card>
          <div className="stat">
            <div className="stat-label">Cobrado hoy</div>
            <div className="stat-value">{money(caja.data.cobrado_cents)}</div>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <div className="stat-label">Falta cobrar</div>
            <div className="stat-value">{money(caja.data.sin_cobrar_cents)}</div>
            <div className="stat-sub">
              {caja.data.sin_cobrar} {caja.data.sin_cobrar === 1 ? 'pedido' : 'pedidos'}
            </div>
          </div>
        </Card>
      </div>

      <Card title={`Falta cobrar (${pendientes.data.pedidos.length})`} tight>
        {!pendientes.data.pedidos.length ? (
          <Empty icon="✓">Está todo cobrado.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Hora</th>
                  <th>Canal</th>
                  <th className="num">Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pendientes.data.pedidos.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{String(p.daily_number).padStart(3, '0')}</td>
                    <td className="nowrap">{stamp(p.created_at)}</td>
                    <td>
                      <Badge tone={p.channel === 'chat' ? 'accent' : 'neutral'}>{p.channel}</Badge>
                    </td>
                    <td className="num">{money(p.total_cents)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn primary small" onClick={() => setCobrando(p)}>
                          Cobrar
                        </button>
                        {estado.data?.mercadopago.activo && (
                          <button className="btn ghost small" onClick={() => pedirLink(p)}>
                            Link de pago
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Cierre de caja">
        {!caja.data.por_medio.length ? (
          <Empty icon="◷">Todavía no se cobró nada hoy.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Medio</th>
                  <th className="num">Pedidos</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {caja.data.por_medio.map((m) => (
                  <tr key={m.payment_method}>
                    <td>{ETIQUETA[m.payment_method] ?? m.payment_method}</td>
                    <td className="num">{m.pedidos}</td>
                    <td className="num">{money(m.total_cents)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="strong">Total</td>
                  <td className="num" />
                  <td className="num strong">{money(caja.data.cobrado_cents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {!estado.data?.mercadopago.activo && estado.data && (
        <p className="small muted">
          Los links de pago de Mercado Pago están apagados. Falta{' '}
          {estado.data.mercadopago.falta.join(', ')}. Cobrar a mano funciona igual.
        </p>
      )}

      {cobrando && (
        <Modal title={`Cobrar #${String(cobrando.daily_number).padStart(3, '0')}`} onClose={() => setCobrando(null)}>
          <p className="small muted" style={{ marginBottom: 14 }}>
            {money(cobrando.total_cents)} · ¿con qué pagó?
          </p>
          <div className="row-actions">
            {MEDIOS.filter((m) => m !== 'mercadopago').map((m) => (
              <button key={m} className="btn" onClick={() => cobrar(cobrando, m)}>
                {ETIQUETA[m]}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {link && (
        <Modal title={`Link de pago ${link.pedido}`} onClose={() => setLink(null)}>
          <p className="small muted" style={{ marginBottom: 10 }}>
            Mandáselo al cliente. Cuando pague, el pedido se marca solo.
          </p>
          <input
            id="link-de-pago"
            className="input mono"
            readOnly
            value={link.url}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Modal>
      )}
    </div>
  );
}
