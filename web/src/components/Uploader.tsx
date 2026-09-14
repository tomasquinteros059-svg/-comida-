import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../lib/toast';
import { Badge, Card, Spinner } from './ui';

type ImportKind = 'carta' | 'insumos' | 'conocimiento';

interface ImportChange { label: string; detail: string }

interface ImportPlan {
  kind: ImportKind;
  filename: string;
  rows_read: number;
  creates: ImportChange[];
  updates: ImportChange[];
  /** De dónde salió: un CSV, una hoja de Excel, un PDF de tantas páginas. */
  origen?: string;
  issues: Array<{ row: number; message: string } | string>;
}

interface ImportResult extends ImportPlan { created: number; updated: number }

const KIND_LABEL: Record<ImportKind, string> = {
  carta: 'Carta y precios',
  insumos: 'Insumos y stock',
  conocimiento: 'Información del local',
};

const ACCEPT =
  '.csv,.tsv,.txt,.md,.json,.xlsx,.xlsm,.xls,.pdf,' +
  'text/csv,text/plain,text/markdown,application/pdf,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_BYTES = 2_500_000;

/** Excel y PDF son binarios: van en base64 y los lee el servidor. */
const esBinario = (nombre: string) => /\.(xlsx|xlsm|xls|pdf)$/i.test(nombre);

/** Lee un archivo binario como base64, sin el prefijo `data:`. */
const aBase64 = (file: File) =>
  new Promise<string>((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onerror = () => rechazar(new Error(`No pude leer ${file.name}`));
    lector.onload = () => resolver(String(lector.result).split(',')[1] ?? '');
    lector.readAsDataURL(file);
  });

/**
 * Subida de archivos para alimentar al bot: la carta exportada del Excel, la
 * lista de insumos o un texto con las políticas del local.
 *
 * Siempre en dos pasos. El archivo se lee, se muestra qué cambiaría y recién
 * ahí se aplica: nadie debería enterarse de que le cambió media carta después
 * de que ya pasó.
 */
export function Uploader({ onApplied }: { onApplied: () => void }) {
  const { notify } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState('');
  const [binario, setBinario] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [kind, setKind] = useState<ImportKind | ''>('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function readFile(file: File, forcedKind?: ImportKind) {
    if (file.size > MAX_BYTES) {
      notify(`${file.name} pesa más de 2,5 MB. Exportá solo las columnas que necesitás.`, 'error');
      return;
    }
    setBusy(true);
    try {
      const esBin = esBinario(file.name);
      const text = esBin ? await aBase64(file) : await file.text();
      setContent(text);
      setBinario(esBin);
      const preview = await api.post<ImportPlan>('/ingest/preview', {
        content: text,
        filename: file.name,
        ...(esBin ? { base64: true } : {}),
        ...(forcedKind ? { kind: forcedKind } : {}),
      });
      setPlan(preview);
      setKind(preview.kind);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'No pude leer el archivo', 'error');
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }

  async function reinterpret(nextKind: ImportKind) {
    if (!content) return;
    setBusy(true);
    try {
      const preview = await api.post<ImportPlan>('/ingest/preview', {
        content,
        filename: plan?.filename,
        ...(binario ? { base64: true } : {}),
        kind: nextKind,
      });
      setPlan(preview);
      setKind(nextKind);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'No pude releer el archivo', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!plan || !content) return;
    setBusy(true);
    try {
      const result = await api.post<ImportResult>('/ingest/apply', {
        content,
        filename: plan.filename,
        ...(binario ? { base64: true } : {}),
        kind,
      });
      notify(`${result.created} creados y ${result.updated} actualizados desde ${result.filename}`, 'ok');
      reset();
      onApplied();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'No pude aplicar el archivo', 'error');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setContent('');
    setBinario(false);
    setPlan(null);
    setKind('');
    if (inputRef.current) inputRef.current.value = '';
  }

  const totalChanges = (plan?.creates.length ?? 0) + (plan?.updates.length ?? 0);

  return (
    <Card
      title="Subir información"
      action={plan ? <button className="btn small" onClick={reset}>Descartar</button> : undefined}
    >
      {!plan && (
        <div
          className={`dropzone${dragging ? ' dragging' : ''}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void readFile(file);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          <p className="strong">Arrastrá un archivo o elegilo</p>
          <p className="small muted">
            La carta exportada del Excel, la lista de insumos o un texto con horarios y
            políticas. Acepta Excel, PDF, CSV, TSV, TXT y Markdown.
          </p>
          <button className="btn primary" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? <Spinner /> : 'Elegir archivo'}
          </button>
        </div>
      )}

      {plan && (
        <div className="stack">
          <div className="row">
            <span className="mono small">{plan.filename}</span>
            <Badge tone="accent">{KIND_LABEL[plan.kind]}</Badge>
            <span className="small faint">{plan.rows_read} filas leídas</span>
          </div>

          <label className="field">
            <span className="field-label">¿Lo interpreté bien?</span>
            <select
              className="select"
              value={kind}
              onChange={(event) => void reinterpret(event.target.value as ImportKind)}
              disabled={busy}
            >
              {(Object.keys(KIND_LABEL) as ImportKind[]).map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          </label>

          {totalChanges === 0 ? (
            <div className="banner warn">
              No encontré nada que aplicar. Revisá que la primera fila tenga los nombres de las
              columnas (por ejemplo <code>nombre, precio, categoría</code>).
            </div>
          ) : (
            <div className="stack">
              <ChangeList title="Se van a crear" tone="ok" changes={plan.creates} />
              <ChangeList title="Se van a actualizar" tone="info" changes={plan.updates} />
            </div>
          )}

          {plan.origen && plan.origen !== 'texto' && (
            <p className="small muted">Leído desde {plan.origen}.</p>
          )}

          {plan.issues.length > 0 && (
            <details open={plan.issues.some((i) => typeof i === 'string')}>
              <summary className="small strong" style={{ cursor: 'pointer', color: 'var(--warn)' }}>
                {plan.issues.length} cosa{plan.issues.length === 1 ? '' : 's'} para mirar antes de aplicar
              </summary>
              <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {plan.issues.slice(0, 20).map((issue, i) => (
                  <li key={i}>
                    {typeof issue === 'string' ? issue : `Fila ${issue.row}: ${issue.message}`}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="row">
            <span className="small faint">
              El bot lo usa desde el mensaje siguiente. No hace falta reiniciar nada.
            </span>
            <button className="btn primary pushed" onClick={() => void apply()} disabled={busy || totalChanges === 0}>
              {busy ? <Spinner /> : `Aplicar ${totalChanges} cambio${totalChanges === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ChangeList({ title, tone, changes }: { title: string; tone: 'ok' | 'info'; changes: ImportChange[] }) {
  if (!changes.length) return null;
  return (
    <div className="stack tight">
      <div className="row tight">
        <Badge tone={tone}>{changes.length}</Badge>
        <span className="small strong">{title}</span>
      </div>
      <ul className="small muted change-list">
        {changes.slice(0, 30).map((change, index) => (
          <li key={`${change.label}-${index}`}>
            <span className="strong">{change.label}</span> — {change.detail}
          </li>
        ))}
        {changes.length > 30 && <li className="faint">…y {changes.length - 30} más</li>}
      </ul>
    </div>
  );
}
