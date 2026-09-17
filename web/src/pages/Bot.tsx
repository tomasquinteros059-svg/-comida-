import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { useAction, useToast } from '../lib/toast';
import type { DemandGap, KnowledgeEntry, Pagina } from '../lib/types';
import { Badge, Card, Empty, Field, Modal, Spinner, Switch } from '../components/ui';
import { timeAgo } from '../lib/format';

interface EstadoRetencion {
  dias: number;
  total: number;
  con_pedido: number;
  mensajes: number;
  la_mas_vieja: string | null;
  a_borrar: number;
}

/**
 * Cuánto tiempo se guardan las conversaciones.
 *
 * Los mensajes traen lo que la gente escribió: nombres, teléfonos,
 * direcciones. Guardarlos para siempre es terminar con una base de datos de
 * clientes que nadie decidió tener. Esta tarjeta es para decidirlo.
 */
function Retencion() {
  const { data, reload } = useApi<EstadoRetencion>('/retencion');
  const ejecutar = useAction();
  const [dias, setDias] = useState<string>('');

  const actual = data?.dias ?? 90;
  const valor = dias === '' ? String(actual) : dias;

  const guardar = () =>
    void ejecutar(async () => {
      await api.put('/retencion', { dias: Number(valor) });
      setDias('');
      await reload();
    }, 'Listo: el plazo quedó guardado');

  const purgar = () =>
    void ejecutar(async () => {
      const r = await api.post<{ conversaciones: number }>('/retencion/purgar');
      await reload();
      return r;
    }, 'Se borraron las conversaciones que pasaron el plazo');

  if (!data) return null;

  return (
    <Card title="Cuánto se guardan las conversaciones">
      <p className="small muted" style={{ marginBottom: 14, maxWidth: '44rem' }}>
        Los mensajes del chat traen lo que la gente escribió: nombres, teléfonos,
        direcciones. Pasado este plazo se borran solos, todos los días. Las
        conversaciones que terminaron en pedido no se tocan nunca: ahí la charla
        es parte de la venta.
      </p>

      <div className="filtros" style={{ marginBottom: 14 }}>
        <Field label="Días" hint="0 = no borrar nunca.">
          <input
            id="retencion-dias"
            className="input"
            type="number"
            min={0}
            max={3650}
            value={valor}
            onChange={(e) => setDias(e.target.value)}
          />
        </Field>
        <button
          className="btn primary small"
          disabled={Number(valor) === actual}
          onClick={guardar}
          aria-label="Guardar el plazo de retención"
        >
          Guardar
        </button>
        {data.a_borrar > 0 && (
          <button className="btn ghost small" onClick={purgar}>
            Borrar ahora las {data.a_borrar} que ya pasaron
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td>Conversaciones guardadas</td>
              <td className="num">{data.total}</td>
            </tr>
            <tr>
              <td>De esas, terminaron en pedido (no se borran)</td>
              <td className="num">{data.con_pedido}</td>
            </tr>
            <tr>
              <td>Mensajes</td>
              <td className="num">{data.mensajes}</td>
            </tr>
            <tr>
              <td>La más vieja</td>
              <td className="num nowrap">
                {data.la_mas_vieja ? timeAgo(data.la_mas_vieja) : '—'}
              </td>
            </tr>
            <tr>
              <td>Esperando el próximo barrido</td>
              <td className="num">{data.dias === 0 ? 'no se borra nada' : data.a_borrar}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type Origen = 'entorno' | 'panel' | 'falta';

interface EstadoWhatsapp {
  activo: boolean;
  falta: string[];
  numero_id: string;
  version: string;
  origen: Record<string, Origen>;
  se_puede_cargar: boolean;
}

/**
 * Las cuatro credenciales de Meta, en el orden en que aparecen en su pantalla.
 *
 * El texto de ayuda de cada una es la mitad del trabajo: son cuatro valores
 * que se parecen entre sí y están en tres pantallas distintas de Meta, y
 * confundirlos es la forma habitual de perder una tarde.
 */
const CREDENCIALES = [
  {
    campo: 'phoneNumberId',
    etiqueta: 'Identificador del número',
    ayuda: 'En "API de WhatsApp", abajo del teléfono. Son dígitos: NO es el teléfono.',
    secreto: false,
  },
  {
    campo: 'token',
    etiqueta: 'Token de acceso',
    ayuda: 'El temporal dura 24 h. Para el local hace falta uno permanente (System User).',
    secreto: true,
  },
  {
    campo: 'verifyToken',
    etiqueta: 'Palabra de verificación',
    ayuda: 'La inventás vos. La misma que pongas acá va en Meta, al dar de alta el webhook.',
    secreto: false,
  },
  {
    campo: 'appSecret',
    etiqueta: 'Clave secreta de la app',
    ayuda: 'En Configuración → Básica de la app. Es con lo que se comprueba que el mensaje vino de Meta.',
    secreto: true,
  },
] as const;

interface Diagnostico {
  paso: string;
  ok: boolean;
  detalle: string;
  arreglo?: string;
}

/**
 * Conectar el WhatsApp del local.
 *
 * Son cuatro credenciales de Meta que se parecen entre sí, y cuando una está
 * mal el error que devuelve Meta no dice cuál. Esta tarjeta prueba cada una
 * por separado y dice qué hacer, para no perder la tarde probando de a una.
 *
 * Las credenciales se cargan desde acá y se guardan CIFRADAS, con una clave
 * que no está en la base. Antes iban solo en el .env del servidor, que está
 * bien para el que lo administra y es una pared para el dueño del local:
 * "conectá WhatsApp" terminaba siendo "conseguite a alguien con SSH".
 *
 * La razón de no guardarlas en claro sigue en pie: la base se copia todas las
 * noches y esas copias andan dando vueltas. Cifradas, una copia perdida no
 * alcanza para mandar mensajes en nombre del local.
 */
function Whatsapp() {
  const { data, reload } = useApi<EstadoWhatsapp>('/canales/whatsapp');
  const run = useAction();
  const { notify } = useToast();
  const [pasos, setPasos] = useState<Diagnostico[] | null>(null);
  const [probando, setProbando] = useState(false);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [editando, setEditando] = useState(false);

  /**
   * La palabra de verificación la inventa el local, y "inventá una palabra"
   * termina siendo "whatsapp123". Se propone una al azar.
   */
  const sugerirPalabra = () => {
    const azar = crypto.getRandomValues(new Uint8Array(12));
    const palabra = Array.from(azar, (b) => b.toString(16).padStart(2, '0')).join('');
    setValores((v) => ({ ...v, verifyToken: palabra }));
  };

  const guardar = () =>
    void run(async () => {
      await api.put('/canales/whatsapp', valores);
      setValores({});
      setEditando(false);
      await reload();
      // Guardar y no probar deja al local sin saber si sirvieron: se prueba
      // solo, que es lo que iba a hacer igual.
      const r = await api.post<{ listo: boolean; pasos: Diagnostico[] }>('/canales/whatsapp/probar');
      setPasos(r.pasos);
      notify(
        r.listo ? 'WhatsApp está conectado' : 'Guardado. Mirá los pasos de abajo',
        r.listo ? 'ok' : 'info',
      );
    });

  const probar = () =>
    void run(async () => {
      setProbando(true);
      try {
        const r = await api.post<{ listo: boolean; pasos: Diagnostico[] }>('/canales/whatsapp/probar');
        setPasos(r.pasos);
        notify(
          r.listo ? 'WhatsApp está conectado' : 'Falta algo: mirá los pasos de abajo',
          r.listo ? 'ok' : 'info',
        );
      } finally {
        setProbando(false);
      }
    });

  if (!data) return null;

  const direccion = `${window.location.origin}/api/whatsapp`;

  return (
    <Card
      title="WhatsApp del local"
      action={
        <button className="btn primary small" onClick={probar} disabled={probando}>
          {probando ? 'Probando…' : 'Probar conexión'}
        </button>
      }
    >
      {data.activo ? (
        <p className="small muted" style={{ marginBottom: 12 }}>
          Las cuatro credenciales están cargadas (número …{data.numero_id.replace(/\D/g, '')}, API{' '}
          {data.version}). Tocá <strong>Probar conexión</strong> para ver si Meta las acepta.
        </p>
      ) : (
        // Una vez que probó, los pasos dicen lo mismo con más detalle: sobra.
        !pasos && (
        <div className="banner warn" style={{ flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          <span>
            <strong>WhatsApp no está conectado.</strong> Falta {data.falta.join(', ')}.
          </span>
          <span className="small">
            Se sacan de <code>developers.facebook.com</code> y se pegan acá abajo. Si preferís que
            las ponga el que administra el servidor, también se pueden dejar en el{' '}
            <code>.env</code>: esas le ganan a las de acá.
          </span>
        </div>
        )
      )}

      {pasos && (
        <div className="stack tight" style={{ marginBottom: 12 }}>
          {pasos.map((p) => (
            <div
              key={p.paso}
              className={`banner ${p.ok ? 'ok' : 'warn'}`}
              style={{ flexDirection: 'column', gap: 4 }}
            >
              <span>
                {p.ok ? '✓' : '✗'} <strong>{p.paso}</strong> · {p.detalle}
              </span>
              {p.arreglo && <span className="small">{p.arreglo}</span>}
            </div>
          ))}
        </div>
      )}

      {(editando || !data.activo) && data.se_puede_cargar && (
        <div className="stack" style={{ marginBottom: 14 }}>
          {CREDENCIALES.map((c) => {
            const origen = data.origen?.[c.campo] ?? 'falta';
            const delServidor = origen === 'entorno';
            return (
              <Field
                key={c.campo}
                label={
                  `${c.etiqueta}${origen === 'panel' ? ' · ya cargada' : ''}` +
                  (delServidor ? ' · la pone el servidor' : '')
                }
                hint={delServidor ? 'Viene del .env: desde acá no se puede cambiar.' : c.ayuda}
              >
                <div className="row tight">
                  <input
                    className="input"
                    type={c.secreto ? 'password' : 'text'}
                    autoComplete="off"
                    disabled={delServidor}
                    value={valores[c.campo] ?? ''}
                    placeholder={origen === 'panel' ? '•••••••• (dejalo vacío para no cambiarla)' : ''}
                    onChange={(e) => setValores((v) => ({ ...v, [c.campo]: e.target.value }))}
                  />
                  {c.campo === 'verifyToken' && !delServidor && (
                    <button className="btn ghost small nowrap" onClick={sugerirPalabra}>
                      Inventar una
                    </button>
                  )}
                </div>
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

          <p className="small muted">
            Se guardan cifradas con una clave que no está en la base: una copia de
            respaldo perdida no alcanza para mandar mensajes en nombre del local.
          </p>
        </div>
      )}

      {data.activo && !editando && (
        <p className="small" style={{ marginBottom: 14 }}>
          <button className="btn ghost small" onClick={() => setEditando(true)}>
            Cambiar las credenciales
          </button>
        </p>
      )}

      <Field
        label="La dirección que va en Meta"
        hint="Webhooks → WhatsApp → Editar. Tiene que ser https y llegar desde afuera."
      >
        <input className="input" readOnly value={direccion} onFocus={(e) => e.target.select()} />
      </Field>

      <Avisos />
    </Card>
  );
}

interface ConfigAvisos {
  activo: boolean;
  demoraMin: number;
}

/**
 * Avisarle al cliente cómo va su pedido.
 *
 * Sin esto el bot toma el pedido y se calla: el cliente se queda mirando el
 * teléfono y a los diez minutos llama al local para preguntar, que es
 * justamente el teléfono que el bot venía a sacarse de encima.
 */
function Avisos() {
  const { data, reload } = useApi<ConfigAvisos>('/canales/avisos');
  const run = useAction();
  const [demora, setDemora] = useState<string>('');

  if (!data) return null;

  const valor = demora === '' ? String(data.demoraMin) : demora;

  const guardar = (cambio: Partial<ConfigAvisos>) =>
    void run(async () => {
      await api.put('/canales/avisos', cambio);
      setDemora('');
      await reload();
    }, 'Listo');

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <div>
          <div className="strong">Avisarle al cliente cómo va su pedido</div>
          <div className="small muted">
            Cuando lo tomás y cuando está listo. Si lo cancelás, con el motivo.
          </div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <Switch
            on={data.activo}
            onChange={() => guardar({ activo: !data.activo })}
            label="Avisarle al cliente por WhatsApp"
          />
        </div>
      </div>

      {data.activo && (
        <div className="filtros">
          <Field
            label="Demora que se promete"
            hint="Minutos. En 0 no promete ningún tiempo."
          >
            <input
              id="avisos-demora"
              className="input"
              type="number"
              min={0}
              max={240}
              value={valor}
              onChange={(e) => setDemora(e.target.value)}
            />
          </Field>
          <button
            className="btn primary small"
            disabled={Number(valor) === data.demoraMin}
            onClick={() => guardar({ demoraMin: Number(valor) })}
            aria-label="Guardar la demora que se promete"
          >
            Guardar
          </button>
        </div>
      )}
    </div>
  );
}

interface FlaggedMessage {
  id: string;
  content: string;
  channel: string;
  created_at: string;
}

/**
 * Todo lo que el local le ensena al bot: politicas y respuestas frecuentes,
 * más las senales de que el bot se equivoco o no supo responder.
 */
export function BotPage() {
  const knowledge = useApi<KnowledgeEntry[]>('/knowledge');
  const flagged = useApi<Pagina<FlaggedMessage>>('/chat/flagged?limite=20', 60_000);
  const gaps = useApi<DemandGap[]>('/demand-gaps?days=30');
  const menuText = useApi<{ text: string }>('/menu/text');
  const run = useAction();
  const [editing, setEditing] = useState<KnowledgeEntry | 'nuevo' | null>(null);

  const toggle = (entry: KnowledgeEntry) =>
    void run(async () => {
      await api.patch(`/knowledge/${entry.id}`, { active: !entry.active });
      await knowledge.reload();
    });

  const remove = (entry: KnowledgeEntry) =>
    void run(async () => {
      await api.del(`/knowledge/${entry.id}`);
      await knowledge.reload();
    }, 'Entrada eliminada');

  if (!knowledge.data) return <Spinner />;

  return (
    <div className="stack">
      <div className="banner info">
        Lo que cargues acá entra en el prompt del bot en el turno siguiente. La carta y los precios
        no hace falta escribirlos: el bot los lee directo de la base.
      </div>

      <Whatsapp />

      <Card
        title="Lo que el bot sabe del local"
        action={<button className="btn primary small" onClick={() => setEditing('nuevo')}>+ Entrada</button>}
        tight
      >
        {knowledge.data.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>Tema</th>
                  <th>Contenido</th>
                  <th className="num">Prioridad</th>
                  <th>Activa</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {knowledge.data.map((entry) => (
                  <tr key={entry.id} style={{ opacity: entry.active ? 1 : 0.5 }}>
                    <td className="strong">{entry.topic}</td>
                    <td className="small">{entry.content}</td>
                    <td className="num">{entry.priority}</td>
                    <td>
                      <Switch on={entry.active} onChange={() => toggle(entry)} label={`Activar ${entry.topic}`} />
                    </td>
                    <td className="nowrap">
                      <button className="btn ghost small" onClick={() => setEditing(entry)}>Editar</button>
                      <button className="btn ghost small danger" onClick={() => remove(entry)}>Borrar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="✦">Todavia no le ensenaste nada al bot</Empty>
        )}
      </Card>

      <div className="grid cols-2">
        <Card title="Respuestas marcadas para revisar" tight>
          {flagged.data?.items.length ? (
            <div className="stack tight" style={{ padding: 14 }}>
              {flagged.data.items.slice(0, 10).map((message) => (
                <div key={message.id} className="banner warn" style={{ flexDirection: 'column', gap: 4 }}>
                  <span className="small">{message.content}</span>
                  <span className="small faint">
                    {message.channel} · {timeAgo(message.created_at)} atrás
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon="✓">
              Ninguna respuesta marcada. Podes marcarlas desde la consola del <a href="#/chat">chatbot</a>.
            </Empty>
          )}
        </Card>

        <Card title="Lo que los clientes buscan y no encuentran" tight>
          {gaps.data?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Motivo</th>
                    <th className="num">Veces</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.data.slice(0, 12).map((gap) => (
                    <tr key={`${gap.query}-${gap.kind}`}>
                      <td>{gap.query}</td>
                      <td>
                        <Badge tone={gap.kind === 'sin_stock' ? 'warn' : 'info'}>
                          {gap.kind === 'sin_stock' ? 'sin stock' : 'falta en la carta'}
                        </Badge>
                      </td>
                      <td className="num">{gap.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon="✓">Todo lo que pidieron estaba disponible</Empty>
          )}
        </Card>
      </div>

      <Card title="Carta como la ve el bot" action={<span className="small faint">solo lectura</span>}>
        <pre className="trace" style={{ maxHeight: 380 }}>
          {menuText.data?.text ?? 'Cargando…'}
        </pre>
      </Card>

      <Retencion />

      {editing && (
        <KnowledgeEditor
          entry={editing === 'nuevo' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void knowledge.reload();
          }}
        />
      )}
    </div>
  );
}

function KnowledgeEditor({
  entry,
  onClose,
  onSaved,
}: {
  entry: KnowledgeEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const run = useAction();
  const [topic, setTopic] = useState(entry?.topic ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [priority, setPriority] = useState(String(entry?.priority ?? 0));

  const save = () =>
    void run(async () => {
      const body = { topic: topic.trim(), content: content.trim(), priority: Number(priority) };
      if (entry) await api.patch(`/knowledge/${entry.id}`, body);
      else await api.post('/knowledge', body);
      onSaved();
    }, 'Listo, el bot ya lo sabe');

  return (
    <Modal
      title={entry ? `Editar: ${entry.topic}` : 'Nueva entrada'}
      onClose={onClose}
      footer={
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button
            className="btn primary"
            onClick={save}
            disabled={!topic.trim() || !content.trim()}
          >
            Guardar
          </button>
        </div>
      }
    >
      <div className="stack">
        <Field label="Tema" hint="Horarios, Delivery, Medios de pago, Promociones…">
          <input className="input" value={topic} onChange={(event) => setTopic(event.target.value)} />
        </Field>
        <Field
          label="Que tiene que saber el bot"
          hint="Escribilo como se lo dirias a un empleado nuevo."
        >
          <textarea
            className="textarea"
            rows={5}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        <Field label="Prioridad" hint="Mas alto aparece primero en el prompt.">
          <input
            className="input"
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
