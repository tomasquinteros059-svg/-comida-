import type { ReactNode } from 'react';

export function Card({
  title,
  action,
  children,
  tight,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <section className="card">
      {(title || action) && (
        <header className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {action && <div className="spacer">{action}</div>}
        </header>
      )}
      <div className={`card-body${tight ? ' tight' : ''}`}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'pos' | 'neg';
}) {
  return (
    <section className="card">
      <div className="stat">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {sub && <div className={`stat-sub${tone ? ` ${tone}` : ''}`}>{sub}</div>}
      </div>
    </section>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

export const Badge = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => (
  <span className={`badge ${tone}`}>{children}</span>
);

export const Empty = ({ icon = '·', children }: { icon?: string; children: ReactNode }) => (
  <div className="empty">
    <span className="empty-icon">{icon}</span>
    {children}
  </div>
);

export const Spinner = () => <span className="spinner" aria-label="Cargando" />;

export function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="switch"
      data-on={on}
      aria-label={label}
      aria-pressed={on}
      onClick={() => onChange(!on)}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="card-head">
          <h2>{title}</h2>
          <div className="spacer">
            <button className="btn ghost small" onClick={onClose} aria-label="Cerrar">
              ✕
            </button>
          </div>
        </header>
        <div className="card-body">{children}</div>
        {footer && <div className="card-head" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>{footer}</div>}
      </div>
    </div>
  );
}

/** Grafico de barras simple. Evita traer una libreria entera para esto. */
export function BarChart({
  data,
  format,
}: {
  data: { label: string; value: number }[];
  format?: (value: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <Empty>Sin datos en el periodo</Empty>;
  return (
    <div className="bars">
      {data.map((d) => (
        <div className="bar-col" key={d.label} title={`${d.label}: ${format ? format(d.value) : d.value}`}>
          <div className="bar" style={{ height: `${Math.max(2, (d.value / max) * 88)}%` }} />
          <span className="bar-label">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Meter({ value, max, tone }: { value: number; max: number; tone: string }) {
  const pctValue = Math.min(100, Math.max(0, (value / Math.max(max, 0.0001)) * 100));
  return (
    <div className="meter">
      <span style={{ width: `${pctValue}%`, background: `var(--${tone})` }} />
    </div>
  );
}

/**
 * Paginador. Muestra el tramo y el total, no solo "anterior/siguiente":
 * "31–60 de 412" le dice al local cuánto hay antes de hacer clic.
 */
export function Paginador({
  desde,
  limite,
  total,
  hayMas,
  onCambiar,
}: {
  desde: number;
  limite: number;
  total: number;
  hayMas: boolean;
  onCambiar: (desde: number) => void;
}) {
  if (total <= limite && desde === 0) return null;
  const hasta = Math.min(desde + limite, total);
  return (
    <div className="paginador">
      <span className="small muted nowrap">
        {total === 0 ? 'sin resultados' : `${desde + 1}–${hasta} de ${total}`}
      </span>
      <div className="row-actions">
        <button
          className="btn ghost small"
          disabled={desde === 0}
          onClick={() => onCambiar(Math.max(0, desde - limite))}
        >
          ← Anterior
        </button>
        <button className="btn ghost small" disabled={!hayMas} onClick={() => onCambiar(desde + limite)}>
          Siguiente →
        </button>
      </div>
    </div>
  );
}
