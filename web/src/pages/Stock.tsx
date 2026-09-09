import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { useLive } from '../lib/useLive';
import { api } from '../lib/api';
import { useAction } from '../lib/toast';
import type { Ingredient, ReplenishmentPlan, StockAlert } from '../lib/types';
import { Badge, Card, Empty, Field, Meter, Modal, Spinner } from '../components/ui';
import { moneyExact } from '../lib/format';

const LEVEL_TONE = { agotado: 'danger', critico: 'danger', bajo: 'warn' } as const;

export function StockPage() {
  const alerts = useApi<StockAlert[]>('/stock/alerts', 30_000);
  const ingredients = useApi<Ingredient[]>('/stock/ingredients');
  const run = useAction();

  const [adjusting, setAdjusting] = useState<Ingredient | null>(null);
  const [plan, setPlan] = useState<ReplenishmentPlan | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadAll = async () => {
    await Promise.all([alerts.reload(), ingredients.reload()]);
  };

  // Una venta o una recepción cambian el stock desde otra pantalla.
  useLive(['stock', 'compras'], () => void reloadAll());

  /** Dispara el servicio de reposición con el plazo elegido. */
  const replenish = (urgency: 'inmediato' | 'express' | 'normal') => {
    setBusy(true);
    void run(async () => {
      const result = await api.post<ReplenishmentPlan>('/procurement/replenish', { urgency });
      setPlan(result);
      await reloadAll();
    }).finally(() => setBusy(false));
  };

  if (alerts.error) return <div className="banner danger">No pude cargar el stock: {alerts.error}</div>;
  if (!alerts.data || !ingredients.data) return <Spinner />;

  const counts = {
    agotado: alerts.data.filter((a) => a.level === 'agotado').length,
    critico: alerts.data.filter((a) => a.level === 'critico').length,
    bajo: alerts.data.filter((a) => a.level === 'bajo').length,
  };

  return (
    <div className="stack">
      <div className="row">
        <Badge tone="danger">{counts.agotado} agotados</Badge>
        <Badge tone="danger">{counts.critico} criticos</Badge>
        <Badge tone="warn">{counts.bajo} bajos</Badge>
        <div className="row tight" style={{ marginLeft: 'auto' }}>
          <button className="btn" disabled={busy} onClick={() => replenish('normal')}>
            Reponer normal
          </button>
          <button className="btn" disabled={busy} onClick={() => replenish('express')}>
            Express (24 h)
          </button>
          <button className="btn primary" disabled={busy} onClick={() => replenish('inmediato')}>
            {busy ? <Spinner /> : 'Pedir ya (4 h)'}
          </button>
        </div>
      </div>

      <Card title="Necesita reposición" tight>
        {alerts.data.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Insumo</th>
                  <th className="num">Stock</th>
                  <th style={{ width: 120 }}>Nivel</th>
                  <th className="num">Consumo/día</th>
                  <th className="num">Alcanza</th>
                  <th className="num">Sugerido</th>
                  <th>Frena estos platos</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {alerts.data.map((alert) => (
                  <tr key={alert.ingredient.id}>
                    <td>
                      <div className="row tight inline">
                        <Badge tone={LEVEL_TONE[alert.level]}>{alert.level}</Badge>
                        <span className="strong">{alert.ingredient.name}</span>
                      </div>
                    </td>
                    <td className="num nowrap">
                      {alert.ingredient.stock_qty} {alert.ingredient.unit}
                      <div className="small faint">min {alert.ingredient.min_qty}</div>
                    </td>
                    <td>
                      <Meter
                        value={alert.ingredient.stock_qty}
                        max={Math.max(alert.ingredient.par_qty, alert.ingredient.min_qty * 2, 1)}
                        tone={LEVEL_TONE[alert.level] === 'danger' ? 'danger' : 'warn'}
                      />
                    </td>
                    <td className="num">{alert.daily_usage || '—'}</td>
                    <td className="num nowrap">
                      {alert.days_left === null ? (
                        <span className="faint">sin consumo</span>
                      ) : (
                        <span className={alert.days_left < 2 ? 'neg strong' : ''}>{alert.days_left} d</span>
                      )}
                    </td>
                    <td className="num nowrap strong">
                      {alert.suggested_qty} {alert.ingredient.unit}
                    </td>
                    <td className="small muted">
                      {alert.blocks_products.join(', ') || '—'}
                    </td>
                    <td>
                      <button className="btn ghost small" onClick={() => setAdjusting(alert.ingredient)}>
                        Ajustar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="✓">Todos los insumos están por encima del mínimo</Empty>
        )}
      </Card>

      <Card title="Todos los insumos" tight>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Insumo</th>
                <th className="num">Stock</th>
                <th className="num">Mínimo</th>
                <th className="num">Objetivo</th>
                <th className="num">Costo unitario</th>
                <th className="num">Valorizado</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ingredients.data.map((ingredient) => (
                <tr key={ingredient.id}>
                  <td>
                    <span className="strong">{ingredient.name}</span>
                    {ingredient.perishable && <> <Badge tone="warn">perecedero</Badge></>}
                  </td>
                  <td className="num nowrap">{ingredient.stock_qty} {ingredient.unit}</td>
                  <td className="num muted">{ingredient.min_qty}</td>
                  <td className="num muted">{ingredient.par_qty}</td>
                  <td className="num">{moneyExact(ingredient.cost_cents)}</td>
                  <td className="num">{moneyExact(Math.round(ingredient.cost_cents * ingredient.stock_qty))}</td>
                  <td>
                    <button className="btn ghost small" onClick={() => setAdjusting(ingredient)}>
                      Ajustar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {adjusting && (
        <AdjustModal
          ingredient={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            void reloadAll();
          }}
        />
      )}

      {plan && <PlanModal plan={plan} onClose={() => setPlan(null)} />}
    </div>
  );
}

function AdjustModal({
  ingredient,
  onClose,
  onSaved,
}: {
  ingredient: Ingredient;
  onClose: () => void;
  onSaved: () => void;
}) {
  const run = useAction();
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<'compra' | 'ajuste' | 'merma'>('compra');
  const [note, setNote] = useState('');
  const [minQty, setMinQty] = useState(String(ingredient.min_qty));
  const [parQty, setParQty] = useState(String(ingredient.par_qty));

  const save = () =>
    void run(async () => {
      const amount = Number(delta);
      if (amount) {
        await api.post(`/stock/ingredients/${ingredient.id}/movements`, {
          delta: reason === 'merma' ? -Math.abs(amount) : amount,
          reason,
          note,
        });
      }
      if (Number(minQty) !== ingredient.min_qty || Number(parQty) !== ingredient.par_qty) {
        await api.patch(`/stock/ingredients/${ingredient.id}`, {
          min_qty: Number(minQty),
          par_qty: Number(parQty),
        });
      }
      onSaved();
    }, `${ingredient.name} actualizado`);

  return (
    <Modal
      title={ingredient.name}
      onClose={onClose}
      footer={
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" onClick={save}>Guardar</button>
        </div>
      }
    >
      <div className="stack">
        <p className="small muted">
          Stock actual: <strong>{ingredient.stock_qty} {ingredient.unit}</strong>. Todo movimiento
          queda registrado con su motivo.
        </p>
        <div className="grid cols-2">
          <Field label={`Movimiento (${ingredient.unit})`} hint="Positivo suma, negativo descuenta.">
            <input
              className="input"
              type="number"
              step="0.01"
              value={delta}
              onChange={(event) => setDelta(event.target.value)}
              placeholder="0"
            />
          </Field>
          <Field label="Motivo">
            <select
              className="select"
              value={reason}
              onChange={(event) => setReason(event.target.value as typeof reason)}
            >
              <option value="compra">Ingreso de mercaderia</option>
              <option value="ajuste">Ajuste de inventario</option>
              <option value="merma">Merma / rotura</option>
            </select>
          </Field>
        </div>
        <Field label="Nota">
          <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
        <div className="grid cols-2">
          <Field label="Punto de reposición" hint="Debajo de esto salta la alerta.">
            <input className="input" type="number" step="0.01" value={minQty} onChange={(e) => setMinQty(e.target.value)} />
          </Field>
          <Field label="Nivel objetivo" hint="Hasta acá compra la reposición automatica.">
            <input className="input" type="number" step="0.01" value={parQty} onChange={(e) => setParQty(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function PlanModal({ plan, onClose }: { plan: ReplenishmentPlan; onClose: () => void }) {
  return (
    <Modal
      title={`Reposición ${plan.urgency}`}
      onClose={onClose}
      footer={
        <div className="row" style={{ width: '100%' }}>
          <span className="small faint">Las ordenes quedan en borrador hasta que las envies.</span>
          <a className="btn primary" href="#/compras" onClick={onClose} style={{ marginLeft: 'auto' }}>
            Ir a compras
          </a>
        </div>
      }
    >
      <div className="stack">
        {!plan.purchase_orders.length && <Empty icon="✓">No hizo falta comprar nada</Empty>}

        {plan.purchase_orders.map((po) => (
          <div className="card" key={po.id}>
            <div className="card-head">
              <h3>{po.supplier_name}</h3>
              <div className="spacer row tight">
                <Badge tone="neutral">{po.code}</Badge>
                <span className="strong">{moneyExact(po.total_cents)}</span>
              </div>
            </div>
            <div className="card-body">
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {po.items.map((item) => (
                  <li key={item.id}>
                    {item.ingredient_name}: {item.qty} {item.unit}
                  </li>
                ))}
              </ul>
              {po.eta_at && (
                <p className="small muted" style={{ marginTop: 8 }}>
                  Entrega estimada: {new Date(po.eta_at).toLocaleString('es-AR')}
                </p>
              )}
            </div>
          </div>
        ))}

        {!!plan.delayed.length && (
          <div className="banner warn">
            <div>
              <strong>Estos insumos no llegan en el plazo pedido.</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {plan.delayed.map((item) => (
                  <li key={item.ingredient_id}>
                    {item.ingredient_name}: {item.supplier_name} entrega en {item.lead_time_hours} h
                    (pediste {item.deadline_hours} h)
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {!!plan.unsourced.length && (
          <div className="banner danger">
            <div>
              <strong>Sin proveedor cargado.</strong> Hay que conseguirlos a mano:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {plan.unsourced.map((item) => (
                  <li key={item.ingredient_id}>{item.ingredient_name}: {item.qty}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
