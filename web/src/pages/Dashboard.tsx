import { useApi } from '../lib/useApi';
import type { Dashboard } from '../lib/types';
import { BarChart, Badge, Card, Empty, Spinner, Stat } from '../components/ui';
import { money, pct, plural, timeAgo } from '../lib/format';

const LEVEL_TONE = { agotado: 'danger', critico: 'danger', bajo: 'warn' } as const;

export function DashboardPage() {
  const { data, loading, error } = useApi<Dashboard>('/dashboard', 30_000);

  if (error) return <div className="banner danger">No pude cargar el panel: {error}</div>;
  if (!data) return loading ? <Spinner /> : null;

  const { today, week, yesterday } = data;
  const marginPct = today.revenue_cents
    ? Math.round((today.margin_cents / today.revenue_cents) * 100)
    : 0;

  return (
    <div className="stack">
      <div className="grid cols-4">
        <Stat
          label="Ventas de hoy"
          value={money(today.revenue_cents)}
          tone={data.revenue_change_pct === null ? undefined : data.revenue_change_pct >= 0 ? 'pos' : 'neg'}
          sub={
            data.revenue_change_pct === null
              ? `Ayer ${money(yesterday.revenue_cents)}`
              : `${pct(data.revenue_change_pct)} contra ayer`
          }
        />
        <Stat
          label="Pedidos"
          value={today.orders}
          sub={`${plural(today.items_sold, 'producto', 'productos')} vendidos`}
        />
        <Stat
          label="Ticket promedio"
          value={money(today.avg_ticket_cents)}
          sub={`Margen bruto ${marginPct}%`}
        />
        <Stat
          label="En cocina"
          value={data.kitchen}
          sub={data.kitchen ? 'Pedidos esperando salida' : 'Todo al día'}
        />
      </div>

      {data.stock_alert_counts.agotado > 0 && (
        <div className="banner danger">
          <strong>{data.stock_alert_counts.agotado}</strong>&nbsp;
          {data.stock_alert_counts.agotado === 1 ? 'insumo agotado' : 'insumos agotados'}. Los platos
          que dependen de ellos ya salieron de la carta del chatbot.
          <a href="#/stock" style={{ marginLeft: 'auto' }}>Ver stock →</a>
        </div>
      )}

      <div className="grid cols-2">
        <Card title="Ventas por hora (hoy)">
          <BarChart
            data={today.by_hour.map((h) => ({ label: `${h.hour}h`, value: h.revenue_cents }))}
            format={money}
          />
        </Card>

        <Card title="Lo más vendido hoy" tight>
          {today.top_products.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="num">Unidades</th>
                    <th className="num">Facturado</th>
                  </tr>
                </thead>
                <tbody>
                  {today.top_products.slice(0, 6).map((p) => (
                    <tr key={p.product_id}>
                      <td>{p.name}</td>
                      <td className="num">{p.qty}</td>
                      <td className="num">{money(p.revenue_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="◌">Todavia no hubo ventas hoy</Empty>
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card
          title="Se está por acabar"
          action={<a className="btn small" href="#/compras">Reponer</a>}
          tight
        >
          {data.stock_alerts.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th className="num">Queda</th>
                    <th className="num">Dura</th>
                    <th>Frena</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stock_alerts.map((alert) => (
                    <tr key={alert.ingredient.id}>
                      <td>
                        <div className="row tight inline">
                          <Badge tone={LEVEL_TONE[alert.level]}>{alert.level}</Badge>
                          {alert.ingredient.name}
                        </div>
                      </td>
                      <td className="num nowrap">
                        {alert.ingredient.stock_qty} {alert.ingredient.unit}
                      </td>
                      <td className="num nowrap">
                        {alert.days_left === null ? '—' : `${alert.days_left} d`}
                      </td>
                      <td className="small muted">
                        {alert.blocks_products.length
                          ? `${alert.blocks_products.slice(0, 2).join(', ')}${
                              alert.blocks_products.length > 2 ? ` +${alert.blocks_products.length - 2}` : ''
                            }`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="✓">El stock está en orden</Empty>
          )}
        </Card>

        <Card
          title="Se están quedando atrás"
          action={<a className="btn small" href="#/carta">Ver carta</a>}
          tight
        >
          {data.lagging.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th className="num">30 d</th>
                    <th>Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lagging.map((item) => (
                    <tr key={item.product_id}>
                      <td>{item.name}</td>
                      <td className="num">{item.qty}</td>
                      <td className="small muted">{item.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="✓">Toda la carta se mueve bien</Empty>
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Lo que pidieron y no pudimos vender" tight>
          {data.demand_gaps.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pedido del cliente</th>
                    <th>Motivo</th>
                    <th className="num">Veces</th>
                    <th className="num">Última</th>
                  </tr>
                </thead>
                <tbody>
                  {data.demand_gaps.map((gap) => (
                    <tr key={`${gap.query}-${gap.kind}`}>
                      <td>{gap.query}</td>
                      <td>
                        <Badge tone={gap.kind === 'sin_stock' ? 'warn' : 'info'}>
                          {gap.kind === 'sin_stock' ? 'sin stock' : 'no está en la carta'}
                        </Badge>
                      </td>
                      <td className="num">{gap.count}</td>
                      <td className="num nowrap faint">{timeAgo(gap.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="✓">No hubo pedidos que no pudieramos cubrir</Empty>
          )}
        </Card>

        <Card title="Últimos 7 días">
          <div className="stack tight">
            <div className="row">
              <span className="muted">Facturación</span>
              <span className="strong" style={{ marginLeft: 'auto' }}>{money(week.revenue_cents)}</span>
            </div>
            <div className="row">
              <span className="muted">Margen bruto</span>
              <span className="strong" style={{ marginLeft: 'auto' }}>{money(week.margin_cents)}</span>
            </div>
            <div className="row">
              <span className="muted">Pedidos</span>
              <span className="strong" style={{ marginLeft: 'auto' }}>{week.orders}</span>
            </div>
            <div className="row">
              <span className="muted">Ticket promedio</span>
              <span className="strong" style={{ marginLeft: 'auto' }}>{money(week.avg_ticket_cents)}</span>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div className="stat-label" style={{ marginBottom: 8 }}>Por canal</div>
            {week.by_channel.map((channel) => (
              <div className="row" key={channel.channel} style={{ marginBottom: 6 }}>
                <Badge tone={channel.channel === 'chat' ? 'accent' : 'neutral'}>{channel.channel}</Badge>
                <span className="small muted">{plural(channel.orders, 'pedido', 'pedidos')}</span>
                <span className="strong small" style={{ marginLeft: 'auto' }}>
                  {money(channel.revenue_cents)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
