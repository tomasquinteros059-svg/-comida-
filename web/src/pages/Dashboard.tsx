import { useApi } from '../lib/useApi';
import type { Dashboard } from '../lib/types';
import { BarChart, Badge, Card, Empty, Seccion, Spinner, Stat } from '../components/ui';
import { money, pct, plural, timeAgo } from '../lib/format';

const LEVEL_TONE = { agotado: 'danger', critico: 'danger', bajo: 'warn' } as const;

/**
 * El panel del local.
 *
 * Está partido en cuatro bloques con nombre, y el orden es el de las
 * preguntas que se hace el dueño cuando lo abre: cómo viene el día, qué
 * tengo que hacer, qué se vende y qué no, cómo viene la semana.
 *
 * Antes era una fila de ocho recuadros iguales. La información era la misma,
 * pero había que leerlos todos para saber cuál pedía algo: la única sección
 * que pide hacer algo es la segunda, y ahora se ve sin leerla.
 */
export function DashboardPage() {
  const { data, loading, error } = useApi<Dashboard>('/dashboard', 30_000);

  if (error) return <div className="banner danger">No pude cargar el panel: {error}</div>;
  if (!data) return loading ? <Spinner /> : null;

  const { today, week, yesterday } = data;
  const marginPct = today.revenue_cents
    ? Math.round((today.margin_cents / today.revenue_cents) * 100)
    : 0;

  return (
    <div className="secciones">
      <Seccion titulo="Cómo viene el día" para="Lo que pasó desde que abriste.">
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

        <Card title="Ventas por hora">
          <BarChart
            data={today.by_hour.map((h) => ({ label: `${h.hour}h`, value: h.revenue_cents }))}
            format={money}
          />
        </Card>
      </Seccion>

      {/* La única sección de la pantalla que pide hacer algo. Va segunda, no
          al final: si queda abajo de todo, nadie llega. */}
      <Seccion
        titulo="Para hacer hoy"
        para="Lo único de esta pantalla que no se arregla mirándolo."
        marcada
      >
        <>
          {data.stock_alert_counts.agotado > 0 && (
            <div className="banner danger" style={{ marginBottom: 12 }}>
              <strong>{data.stock_alert_counts.agotado}</strong>&nbsp;
              {data.stock_alert_counts.agotado === 1 ? 'insumo agotado' : 'insumos agotados'}. Los
              platos que dependen de ellos ya salieron de la carta del chatbot.
              <a href="#/stock" style={{ marginLeft: 'auto' }}>Ver stock →</a>
            </div>
          )}

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
                        {/* En el teléfono no entra y se corta al medio de una
                            palabra: ahí se muestra abajo del nombre. */}
                        <th className="solo-ancho">Frena</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.stock_alerts.map((alert) => {
                        const frena = alert.blocks_products.length
                          ? `${alert.blocks_products.slice(0, 2).join(', ')}${
                              alert.blocks_products.length > 2
                                ? ` +${alert.blocks_products.length - 2}`
                                : ''
                            }`
                          : '—';
                        return (
                          <tr key={alert.ingredient.id}>
                            <td>
                              <div className="row tight inline">
                                <Badge tone={LEVEL_TONE[alert.level]}>{alert.level}</Badge>
                                {alert.ingredient.name}
                              </div>
                              <div className="small muted solo-angosto" style={{ marginTop: 3 }}>
                                Frena: {frena}
                              </div>
                            </td>
                            <td className="num nowrap">
                              {alert.ingredient.stock_qty} {alert.ingredient.unit}
                            </td>
                            <td className="num nowrap">
                              {alert.days_left === null ? '—' : `${alert.days_left} d`}
                            </td>
                            <td className="small muted solo-ancho">{frena}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty icon="✓">El stock está en orden</Empty>
              )}
            </Card>

            <Card
              title="Lo que pidieron y no pudimos vender"
              action={<a className="btn small" href="#/carta">Ver carta</a>}
              tight
            >
              {data.demand_gaps.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Pedido del cliente</th>
                        <th>Motivo</th>
                        <th className="num">Veces</th>
                        <th className="num solo-ancho">Última</th>
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
                          <td className="num nowrap faint solo-ancho">{timeAgo(gap.last_seen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty icon="✓">No hubo pedidos que no pudieramos cubrir</Empty>
              )}
            </Card>
          </div>
        </>
      </Seccion>

      {/* Las dos caras de la misma pregunta, una al lado de la otra: qué
          conviene tener siempre y qué conviene sacar. */}
      <Seccion
        titulo="Qué se vende y qué no"
        para="Para decidir qué tocar de la carta."
        accion={<a className="btn small" href="#/carta">Ver carta</a>}
      >
        <div className="grid cols-2">
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

          <Card title="Se están quedando atrás" tight>
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
      </Seccion>

      <Seccion titulo="Cómo viene la semana" para="Los últimos 7 días, para comparar contra hoy.">
        <Card>
          <div className="grid cols-2">
            <div className="stack tight">
              <div className="stat-label" style={{ marginBottom: 2 }}>Totales</div>
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

            <div>
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
          </div>
        </Card>
      </Seccion>
    </div>
  );
}
