import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAction, useToast } from '../lib/toast';
import type { ChatTurn } from '../lib/types';
import { Badge, Card, Empty, Spinner } from '../components/ui';
import { Uploader } from '../components/Uploader';
import { useLive } from '../lib/useLive';
import { clock, timeAgo } from '../lib/format';

interface Bubble {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  trace?: ChatTurn['trace'];
}

const SUGGESTIONS = [
  'Hola, ¿qué tienen para comer?',
  'Quiero 6 empanadas de carne y una gaseosa',
  '¿Qué me recomendás?',
  '¿Cuánto es el total?',
  'Confirmar',
];

/**
 * Consola de pruebas del chatbot: es el mismo endpoint que usa el cliente
 * final, pero mostrando las herramientas que ejecuto en cada turno.
 */
export function ChatPage() {
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [lastTurn, setLastTurn] = useState<ChatTurn | null>(null);
  const [liveEvent, setLiveEvent] = useState<{ text: string; at: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const { notify } = useToast();
  const run = useAction();

  const { data: engine } = useApi<{ engine: string }>('/chat/engine');

  // El bot lee la carta y el stock en cada turno, así que un cambio hecho
  // desde el panel ya está aplicado. Esto solo lo hace visible para quien
  // está mirando la conversación.
  useLive(['stock', 'carta', 'conocimiento'], (event) => {
    const labels: Partial<Record<typeof event.type, string>> = {
      stock: 'Se movió el stock',
      carta: 'Cambió la carta',
      conocimiento: 'Cambió la información del local',
    };
    const label = labels[event.type] ?? 'Cambió algo';
    setLiveEvent({ text: `${label}${event.detail ? `: ${event.detail}` : ''}`, at: event.at });
  });

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send(text: string) {
    if (!text.trim() || sending) return;
    setInput('');
    setMessages((current) => [
      ...current,
      { id: `local-${Date.now()}`, role: 'user', text },
    ]);
    setSending(true);
    try {
      const turn = await api.post<ChatTurn>('/chat', {
        message: text,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      });
      setConversationId(turn.conversation_id);
      setLastTurn(turn);
      setMessages((current) => [
        ...current,
        { id: turn.message_id, role: 'assistant', text: turn.reply, trace: turn.trace },
      ]);
      if (turn.order_id) notify('El pedido entró a cocina', 'ok');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'No pude hablar con el bot', 'error');
    } finally {
      setSending(false);
    }
  }

  const rate = (messageId: string, rating: 1 | -1) =>
    void run(
      () => api.post(`/chat/messages/${messageId}/rating`, { rating }),
      rating === 1 ? 'Marcado como buena respuesta' : 'Marcado para revisar',
    );

  return (
    <div className="chat-shell">
      <div className="stack">
        <Card
          title="Probar el chatbot"
          action={
            <div className="row tight">
              <Badge tone={engine?.engine === 'llm' ? 'accent' : 'neutral'}>
                {engine?.engine === 'llm' ? 'motor: Claude' : 'motor: determinista'}
              </Badge>
              <button
                className="btn small"
                onClick={() => {
                  setMessages([]);
                  setConversationId(null);
                  setLastTurn(null);
                }}
              >
                Nueva charla
              </button>
            </div>
          }
          tight
        >
          {liveEvent && (
            <div className="banner info" style={{ borderRadius: 0, borderWidth: '0 0 1px' }}>
              <span>{liveEvent.text}. El bot ya lo tiene en cuenta.</span>
              <span className="small faint pushed nowrap">{clock(liveEvent.at)}</span>
            </div>
          )}
          <div className="chat-log" ref={logRef}>
            {!messages.length && (
              <Empty icon="◈">
                Escribí como si fueras un cliente. El bot solo puede ofrecer lo que está en la carta.
              </Empty>
            )}
            {messages.map((message) => (
              <div key={message.id} className={`bubble ${message.role}`}>
                {message.text}
                {message.role === 'assistant' && !message.id.startsWith('local-') && (
                  <div className="bubble-actions">
                    <button className="btn ghost small" onClick={() => rate(message.id, 1)} title="Buena respuesta">
                      ↑
                    </button>
                    <button className="btn ghost small" onClick={() => rate(message.id, -1)} title="Revisar está respuesta">
                      ↓
                    </button>
                  </div>
                )}
              </div>
            ))}
            {sending && <div className="bubble assistant"><Spinner /></div>}
          </div>

          <form
            className="chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            <input
              className="input"
              placeholder="Escribí el mensaje del cliente…"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={sending}
            />
            <button className="btn primary" type="submit" disabled={sending || !input.trim()}>
              Enviar
            </button>
          </form>
        </Card>

        <div className="row tight">
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} className="btn small" onClick={() => void send(suggestion)} disabled={sending}>
              {suggestion}
            </button>
          ))}
        </div>
      </div>

      <div className="stack">
        <Uploader onApplied={() => setLiveEvent(null)} />

        <Card title="Qué hizo el bot">
          {lastTurn?.trace.length ? (
            <div className="stack tight">
              {lastTurn.trace.map((step, index) => (
                <details key={index} open={index === 0}>
                  <summary className="small strong" style={{ cursor: 'pointer' }}>
                    {step.tool}
                  </summary>
                  <pre className="trace">{JSON.stringify(step.output, null, 2)}</pre>
                </details>
              ))}
            </div>
          ) : (
            <p className="small muted">
              Cada turno muestra acá las herramientas que ejecutó el bot: qué buscó en la carta, qué
              agregó al pedido y con qué datos lo confirmó. Los precios y el stock salen siempre de
              la base, nunca del modelo.
            </p>
          )}
        </Card>

        <Conversations />
      </div>
    </div>
  );
}

interface ConversationSummary {
  id: string;
  channel: string;
  message_count: number;
  last_message: string | null;
  updated_at: string;
  order_id: string | null;
}

function Conversations() {
  const { data } = useApi<ConversationSummary[]>('/chat/conversations', 20_000);
  if (!data?.length) return null;
  return (
    <Card title="Conversaciones recientes" tight>
      <div className="stack tight" style={{ padding: 12 }}>
        {data.slice(0, 8).map((conversation) => (
          <div key={conversation.id} className="stack tight" style={{ gap: 2 }}>
            <div className="row tight">
              <Badge tone={conversation.order_id ? 'ok' : 'neutral'}>
                {conversation.order_id ? 'pedido cerrado' : conversation.channel}
              </Badge>
              <span className="faint small" style={{ marginLeft: 'auto' }}>
                {timeAgo(conversation.updated_at)}
              </span>
            </div>
            <p className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {conversation.last_message ?? 'Sin mensajes'}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}
