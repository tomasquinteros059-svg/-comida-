import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { useLive } from '../lib/useLive';
import { api } from '../lib/api';
import { useAction, useToast } from '../lib/toast';
import type { PurchaseOrder, Supplier } from '../lib/types';
import { Badge, Card, Empty, Field, Modal, Spinner } from '../components/ui';
import { moneyExact, timeAgo } from '../lib/format';

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'warn' | 'ok' | 'danger'> = {
  borrador: 'neutral',
  enviada: 'info',
  confirmada: 'warn',
  recibida: 'ok',
  cancelada: 'danger',
};

const NEXT: Record<string, { status: string; label: string }> = {
  borrador: { status: 'enviada', label: 'Marcar enviada' },
  enviada: { status: 'confirmada', label: 'Proveedor confirmo' },
  confirmada: { status: 'recibida', label: 'Recibir mercaderia' },
};

const URGENCY_TONE: Record<string, 'neutral' | 'warn' | 'danger'> = {
  normal: 'neutral',
  express: 'warn',
  inmediato: 'danger',
};

export function PurchasesPage() {
  const orders = useApi<PurchaseOrder[]>('/procurement/purchase-orders', 30_000);
  const suppliers = useApi<Supplier[]>('/procurement/suppliers');
  const run = useAction();
  const { notify } = useToast();
  useLive(['compras'], () => void orders.reload());
  const [message, setMessage] = useState<{ code: string; text: string } | null>(null);
  const [newSupplier, setNewSupplier] = useState(false);

  const advance = (po: PurchaseOrder, status: string) =>
    void run(async () => {
      await api.post(`/procurement/purchase-orders/${po.id}/status`, { status });
      await orders.reload();
    }, status === 'recibida' ? 'Mercaderia ingresada al stock' : 'Orden actualizada');

  const openMessage = (po: PurchaseOrder) =>
    void run(async () => {
      const text = await fetch(`/api/procurement/purchase-orders/${po.id}/message`).then((r) => r.text());
      setMessage({ code: po.code, text });
    });

  if (orders.error) return <div className="banner danger">No pude cargar las compras: {orders.error}</div>;
  if (!orders.data || !suppliers.data) return <Spinner />;

  const open = orders.data.filter((po) => !['recibida', 'cancelada'].includes(po.status));
  const closed = orders.data.filter((po) => ['recibida', 'cancelada'].includes(po.status));

  return (
    <div className="stack">
      <Card title={`Ordenes en curso (${open.length})`} tight>
        {open.length ? (
          <div className="stack" style={{ padding: 14 }}>
            {open.map((po) => (
              <div className="card" key={po.id}>
                <div className="card-head">
                  <h3>{po.supplier_name}</h3>
                  <Badge tone={URGENCY_TONE[po.urgency] ?? 'neutral'}>{po.urgency}</Badge>
                  <Badge tone={STATUS_TONE[po.status] ?? 'neutral'}>{po.status}</Badge>
                  <div className="spacer row tight">
                    <span className="mono faint">{po.code}</span>
                    <span className="strong">{moneyExact(po.total_cents)}</span>
                  </div>
                </div>
                <div className="card-body">
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Insumo</th>
                          <th className="num">Cantidad</th>
                          <th className="num">Precio unitario</th>
                          <th className="num">Subtotal</th>
                        </tr>
                      </thead>
                      <tbody>
                        {po.items.map((item) => (
                          <tr key={item.id}>
                            <td>{item.ingredient_name}</td>
                            <td className="num nowrap">{item.qty} {item.unit}</td>
                            <td className="num">{moneyExact(item.unit_cents)}</td>
                            <td className="num">{moneyExact(Math.round(item.unit_cents * item.qty))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {po.note && <p className="small muted" style={{ marginTop: 10 }}>{po.note}</p>}

                  <div className="row" style={{ marginTop: 12 }}>
                    <span className="small faint">
                      Creada {timeAgo(po.created_at)} atrás
                      {po.eta_at ? ` · llega ${new Date(po.eta_at).toLocaleString('es-AR')}` : ''}
                    </span>
                    <div className="row tight" style={{ marginLeft: 'auto' }}>
                      <button className="btn small" onClick={() => openMessage(po)}>
                        Mensaje al proveedor
                      </button>
                      {po.supplier_phone && (
                        <a
                          className="btn small"
                          href={`https://wa.me/${po.supplier_phone.replace(/\D/g, '')}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          WhatsApp
                        </a>
                      )}
                      {NEXT[po.status] && (
                        <button className="btn primary small" onClick={() => advance(po, NEXT[po.status]!.status)}>
                          {NEXT[po.status]!.label}
                        </button>
                      )}
                      <button className="btn ghost small danger" onClick={() => advance(po, 'cancelada')}>
                        Cancelar
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon="✓">
            No hay compras pendientes. Se generan solas desde <a href="#/stock">Stock</a>.
          </Empty>
        )}
      </Card>

      <Card
        title="Proveedores"
        action={<button className="btn small" onClick={() => setNewSupplier(true)}>+ Proveedor</button>}
        tight
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Proveedor</th>
                <th>Teléfono</th>
                <th className="num">Plazo</th>
                <th className="num">Mínimo</th>
                <th>Nota</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.data.map((supplier) => (
                <tr key={supplier.id}>
                  <td>
                    <div className="row tight">
                      <span className="strong">{supplier.name}</span>
                      {supplier.express && <Badge tone="accent">express</Badge>}
                    </div>
                  </td>
                  <td className="mono">{supplier.phone || '—'}</td>
                  <td className="num nowrap">{supplier.lead_time_hours} h</td>
                  <td className="num">{supplier.min_order_cents ? moneyExact(supplier.min_order_cents) : '—'}</td>
                  <td className="small muted">{supplier.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {!!closed.length && (
        <Card title="Historial" tight>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Proveedor</th>
                  <th>Estado</th>
                  <th className="num">Total</th>
                  <th className="num">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {closed.slice(0, 15).map((po) => (
                  <tr key={po.id}>
                    <td className="mono">{po.code}</td>
                    <td>{po.supplier_name}</td>
                    <td><Badge tone={STATUS_TONE[po.status] ?? 'neutral'}>{po.status}</Badge></td>
                    <td className="num">{moneyExact(po.total_cents)}</td>
                    <td className="num faint nowrap">{timeAgo(po.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {message && (
        <Modal
          title={`Mensaje · ${message.code}`}
          onClose={() => setMessage(null)}
          footer={
            <button
              className="btn primary"
              style={{ marginLeft: 'auto' }}
              onClick={() => {
                void navigator.clipboard.writeText(message.text);
                notify('Mensaje copiado', 'ok');
              }}
            >
              Copiar
            </button>
          }
        >
          <pre className="trace" style={{ maxHeight: 380 }}>{message.text}</pre>
        </Modal>
      )}

      {newSupplier && (
        <SupplierEditor
          onClose={() => setNewSupplier(false)}
          onSaved={() => {
            setNewSupplier(false);
            void suppliers.reload();
          }}
        />
      )}
    </div>
  );
}

function SupplierEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const run = useAction();
  const [form, setForm] = useState({ name: '', phone: '', lead: '24', express: false, note: '' });

  const save = () =>
    void run(async () => {
      await api.post('/procurement/suppliers', {
        name: form.name.trim(),
        phone: form.phone.trim(),
        lead_time_hours: Number(form.lead),
        express: form.express,
        note: form.note.trim(),
      });
      onSaved();
    }, 'Proveedor agregado');

  return (
    <Modal
      title="Nuevo proveedor"
      onClose={onClose}
      footer={
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" onClick={save} disabled={!form.name.trim()}>Guardar</button>
        </div>
      }
    >
      <div className="stack">
        <Field label="Nombre">
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid cols-2">
          <Field label="Teléfono" hint="Con código de area, para el link de WhatsApp.">
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Plazo de entrega (horas)" hint="Define si sirve para un pedido urgente.">
            <input
              className="input"
              type="number"
              min="0"
              value={form.lead}
              onChange={(e) => setForm({ ...form, lead: e.target.value })}
            />
          </Field>
        </div>
        <label className="row tight">
          <input
            type="checkbox"
            checked={form.express}
            onChange={(e) => setForm({ ...form, express: e.target.checked })}
          />
          <span>Hace entregas express (mismo día)</span>
        </label>
        <Field label="Nota">
          <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
