import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { useAction } from '../lib/toast';
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
        <button className="btn primary small" disabled={Number(valor) === actual} onClick={guardar}>
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
