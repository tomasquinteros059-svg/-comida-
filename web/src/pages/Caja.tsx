import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAction, useToast } from '../lib/toast';
import { useLive } from '../lib/useLive';
import { Badge, Card, Empty, Field, Modal, Spinner } from '../components/ui';
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
  const estado = useApi<EstadoDeCobros>('/cobros/estado');
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

      {estado.data && <Cobrar estado={estado.data} recargar={estado.reload} />}

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

type OrigenMP = 'entorno' | 'panel' | 'falta';

interface EstadoDeCobros {
  mercadopago: {
    activo: boolean;
    falta: string[];
    origen: Record<string, OrigenMP>;
    se_puede_cargar: boolean;
  };
  medios?: string[];
}

interface PasoDeCobros {
  paso: string;
  ok: boolean;
  detalle: string;
  arreglo?: string;
}

/**
 * Los tres datos de Mercado Pago, en el orden en que aparecen en su pantalla.
 *
 * El texto de ayuda de cada uno es la mitad del trabajo: el error más caro de
 * todos es pegar el token de PRUEBA en vez del de producción, porque todo
 * parece andar —se genera el link, el cliente "paga"— y la plata no entra
 * nunca.
 */
const CREDENCIALES_MP = [
  {
    campo: 'accessToken',
    etiqueta: 'Access Token',
    ayuda: 'Tus integraciones → tu aplicación → Credenciales. El de PRODUCCIÓN, no el de prueba.',
    secreto: true,
  },
  {
    campo: 'webhookSecret',
    etiqueta: 'Clave del webhook',
    ayuda: 'En la misma pantalla de Webhooks. Con esto se comprueba que el aviso lo mandó Mercado Pago.',
    secreto: true,
  },
  {
    campo: 'urlBase',
    etiqueta: 'Dirección pública del local',
    ayuda: 'Adonde vuelve el cliente después de pagar. Tiene que ser https y llegar desde afuera.',
    secreto: false,
  },
] as const;

/**
 * Conectar Mercado Pago desde el panel.
 *
 * Antes esto solo se podía hacer editando un archivo en el servidor, que para
 * el dueño de un local es lo mismo que no poder hacerlo. Se guardan cifradas,
 * igual que las de WhatsApp: la base se respalda y esas copias circulan.
 *
 * Cobrar a mano no depende de nada de esto y funciona siempre.
 */
function Cobrar({ estado, recargar }: { estado: EstadoDeCobros; recargar: () => Promise<void> | void }) {
  const mp = estado.mercadopago;
  const run = useAction();
  const { notify } = useToast();
  const [valores, setValores] = useState<Record<string, string>>({});
  const [editando, setEditando] = useState(false);
  const [pasos, setPasos] = useState<PasoDeCobros[] | null>(null);

  const direccion = window.location.origin;

  const guardar = () =>
    void run(async () => {
      await api.put('/cobros/credenciales', valores);
      setValores({});
      setEditando(false);
      await recargar();
      const r = await api.post<{ listo: boolean; pasos: PasoDeCobros[] }>('/cobros/probar');
      setPasos(r.pasos);
      notify(
        r.listo ? 'Mercado Pago está conectado' : 'Guardado. Mirá los pasos de abajo',
        r.listo ? 'ok' : 'info',
      );
    });

  const probar = () =>
    void run(async () => {
      const r = await api.post<{ listo: boolean; pasos: PasoDeCobros[] }>('/cobros/probar');
      setPasos(r.pasos);
      notify(r.listo ? 'Mercado Pago está conectado' : 'Falta algo: mirá los pasos', r.listo ? 'ok' : 'info');
    });

  return (
    <Card
      title="Links de pago (Mercado Pago)"
      action={
        mp.activo ? (
          <button className="btn small" onClick={probar}>Probar conexión</button>
        ) : undefined
      }
    >
      {mp.activo ? (
        <p className="small muted" style={{ marginBottom: 12 }}>
          Los links de pago están prendidos: al cobrar un pedido del chat podés
          mandarle un link en vez de esperarlo en el mostrador.
        </p>
      ) : (
        <div className="banner warn" style={{ flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          <span><strong>Los links de pago están apagados.</strong> Falta {mp.falta.join(', ')}.</span>
          <span className="small">
            Cobrar a mano —efectivo, débito, transferencia— funciona igual y es la
            mayoría de lo que pasa en un mostrador.
          </span>
        </div>
      )}

      {pasos && (
        <div className="stack tight" style={{ marginBottom: 12 }}>
          {pasos.map((p) => (
            <div key={p.paso} className={`banner ${p.ok ? 'ok' : 'warn'}`} style={{ flexDirection: 'column', gap: 4 }}>
              <span>{p.ok ? '✓' : '✗'} <strong>{p.paso}</strong> · {p.detalle}</span>
              {p.arreglo && <span className="small">{p.arreglo}</span>}
            </div>
          ))}
        </div>
      )}

      {(editando || !mp.activo) && mp.se_puede_cargar && (
        <div className="stack">
          {CREDENCIALES_MP.map((c) => {
            const origen = mp.origen?.[c.campo] ?? 'falta';
            const delServidor = origen === 'entorno';
            return (
              <Field
                key={c.campo}
                label={
                  `${c.etiqueta}${origen === 'panel' ? ' · ya cargado' : ''}` +
                  (delServidor ? ' · lo pone el servidor' : '')
                }
                hint={delServidor ? 'Viene del .env: desde acá no se puede cambiar.' : c.ayuda}
              >
                <input
                  className="input"
                  type={c.secreto ? 'password' : 'text'}
                  autoComplete="off"
                  disabled={delServidor}
                  value={valores[c.campo] ?? ''}
                  placeholder={
                    origen === 'panel'
                      ? '•••••••• (dejalo vacío para no cambiarlo)'
                      : c.campo === 'urlBase'
                        ? direccion
                        : ''
                  }
                  onChange={(e) => setValores((v) => ({ ...v, [c.campo]: e.target.value }))}
                />
              </Field>
            );
          })}

          <div className="row tight">
            <button
              className="btn primary small"
              disabled={Object.values(valores).every((v) => !v?.trim())}
              onClick={guardar}
            >
              Guardar y probar
            </button>
            {editando && (
              <button className="btn ghost small" onClick={() => { setValores({}); setEditando(false); }}>
                Cancelar
              </button>
            )}
          </div>

          <Field
            label="La dirección del aviso, para pegar en Mercado Pago"
            hint="Tus integraciones → Webhooks, con el evento «Pagos»."
          >
            <input className="input" readOnly value={`${direccion}/api/cobros/webhook`} onFocus={(e) => e.target.select()} />
          </Field>

          <p className="small muted">
            Se guardan cifradas con una clave que no está en la base: una copia de
            respaldo perdida no alcanza para cobrar en nombre del local.
          </p>
        </div>
      )}

      {mp.activo && !editando && (
        <button className="btn ghost small" onClick={() => setEditando(true)}>
          Cambiar los datos
        </button>
      )}
    </Card>
  );
}
