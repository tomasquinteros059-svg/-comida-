import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAction } from '../lib/toast';
import { Badge, Card, Empty, Field, Modal, Paginador, Spinner } from '../components/ui';
import type { Pagina } from '../lib/types';
import {
  DESCRIPCION_ROL,
  ETIQUETA_PERMISO,
  type ListadoUsuarios,
  type Rol,
  type Usuario,
} from '../lib/sesion';

const ROLES: Rol[] = ['dueño', 'encargado', 'cocina'];

const TONO_ROL: Record<Rol, 'accent' | 'info' | 'neutral'> = {
  'dueño': 'accent',
  encargado: 'info',
  cocina: 'neutral',
};

interface Auditoria {
  user_name: string;
  role: string;
  action: string;
  target: string;
  detail: string;
  created_at: string;
}

type PaginaDeAuditoria = Pagina<Auditoria> & { quienes: string[] };

const LIMITE_BITACORA = 25;

/**
 * Quién entra y qué puede tocar. Es la pantalla del dueño: nadie más la ve.
 */
export function UsuariosPage({ yo }: { yo: string | null }) {
  const { data, loading, reload } = useApi<ListadoUsuarios & { duenios_activos: number }>('/usuarios');
  const ejecutar = useAction();
  const [alta, setAlta] = useState(false);
  const [editando, setEditando] = useState<Usuario | null>(null);

  // Filtros de la bitácora. Una lista sola alcanza la primera semana; después
  // la pregunta real es "¿quién tocó el precio de la pizza el jueves?".
  const [quien, setQuien] = useState('');
  const [texto, setTexto] = useState('');
  const [desdeFecha, setDesdeFecha] = useState('');
  const [hastaFecha, setHastaFecha] = useState('');
  const [desde, setDesde] = useState(0);

  const consulta = new URLSearchParams({ limite: String(LIMITE_BITACORA), desde: String(desde) });
  if (quien) consulta.set('quien', quien);
  if (texto.trim()) consulta.set('texto', texto.trim());
  if (desdeFecha) consulta.set('desde_fecha', desdeFecha);
  if (hastaFecha) consulta.set('hasta_fecha', hastaFecha);

  const { data: auditoria, reload: recargarAuditoria } = useApi<PaginaDeAuditoria>(
    `/usuarios/auditoria?${consulta.toString()}`,
  );

  const refrescar = () => {
    void reload();
    void recargarAuditoria();
  };

  /** Cambiar un filtro vuelve a la primera página: si no, se ve vacío. */
  const filtrar = (aplicar: () => void) => {
    aplicar();
    setDesde(0);
  };

  async function cambiar(usuario: Usuario, cambio: Record<string, unknown>, aviso: string) {
    if (await ejecutar(() => api.patch(`/usuarios/${usuario.id}`, cambio), aviso)) refrescar();
  }

  if (loading && !data) return <Spinner />;

  const usuarios = data?.usuarios ?? [];

  return (
    <div className="stack">
      {data && data.duenios_activos < 2 && (
        <div className="banner warn">
          <strong>Hay un solo dueño.</strong> Si esa persona pierde la clave o
          se toma vacaciones, la única forma de entrar es el token maestro del
          servidor. Dale de alta a alguien más como dueño: se tarda un minuto y
          evita quedarse afuera del propio local.
        </div>
      )}
      <Card
        title="Equipo"
        action={
          <button className="btn primary small" onClick={() => setAlta(true)}>
            Dar de alta
          </button>
        }
      >
        {usuarios.length === 0 ? (
          <Empty icon="◍">Todavía no hay nadie más que vos.</Empty>
        ) : (
          <div className="stack">
            {usuarios.map((u) => (
              <div key={u.id} className={`usuario-fila${u.active ? '' : ' usuario-inactivo'}`}>
                <div className="usuario-datos">
                  <div className="usuario-nombre">
                    {u.name}
                    {u.id === yo && <span className="small muted"> · sos vos</span>}
                  </div>
                  <div className="usuario-alias">
                    @{u.username} ·{' '}
                    {u.last_login_at ? `última entrada ${fecha(u.last_login_at)}` : 'nunca entró'}
                  </div>
                </div>
                <Badge tone={TONO_ROL[u.role]}>{u.role}</Badge>
                {!u.active && <Badge tone="danger">de baja</Badge>}
                <div className="row-actions">
                  <button className="btn ghost small" onClick={() => setEditando(u)}>
                    Editar
                  </button>
                  {u.id !== yo && (
                    <button
                      className="btn ghost small"
                      onClick={() =>
                        void cambiar(
                          u,
                          { active: !u.active },
                          u.active ? `${u.name} ya no puede entrar` : `${u.name} vuelve a entrar`,
                        )
                      }
                    >
                      {u.active ? 'Dar de baja' : 'Reactivar'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Qué ve cada rol">
        <div className="stack">
          {ROLES.map((rol) => (
            <div key={rol}>
              <Badge tone={TONO_ROL[rol]}>{rol}</Badge>
              <span className="small muted"> {DESCRIPCION_ROL[rol]}</span>
              <div className="permiso-chips">
                {(data?.roles.find((r) => r.rol === rol)?.permisos ?? []).map((p) => (
                  <span key={p} className="permiso-chip">
                    {ETIQUETA_PERMISO[p]}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Registro de cambios">
        <div className="filtros" style={{ marginBottom: 14 }}>
          <Field label="Quién">
            <select
              id="bitacora-quien"
              className="input"
              value={quien}
              onChange={(e) => filtrar(() => setQuien(e.target.value))}
            >
              <option value="">todos</option>
              {(auditoria?.quienes ?? []).map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Qué">
            <input
              id="bitacora-texto"
              className="input"
              value={texto}
              placeholder="precio, mozzarella…"
              onChange={(e) => filtrar(() => setTexto(e.target.value))}
            />
          </Field>
          <Field label="Desde">
            <input
              id="bitacora-desde"
              className="input"
              type="date"
              value={desdeFecha}
              onChange={(e) => filtrar(() => setDesdeFecha(e.target.value))}
            />
          </Field>
          <Field label="Hasta">
            <input
              id="bitacora-hasta"
              className="input"
              type="date"
              value={hastaFecha}
              onChange={(e) => filtrar(() => setHastaFecha(e.target.value))}
            />
          </Field>
          {(quien || texto || desdeFecha || hastaFecha) && (
            <button
              className="btn ghost small"
              onClick={() =>
                filtrar(() => {
                  setQuien('');
                  setTexto('');
                  setDesdeFecha('');
                  setHastaFecha('');
                })
              }
            >
              Limpiar
            </button>
          )}
        </div>

        {!auditoria?.items.length ? (
          <Empty icon="⌁">
            {quien || texto || desdeFecha || hastaFecha
              ? 'No hay movimientos con esos filtros.'
              : 'Todavía no hay nada registrado.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Quién</th>
                  <th>Qué hizo</th>
                </tr>
              </thead>
              <tbody>
                {auditoria.items.map((fila, i) => (
                  <tr key={i}>
                    <td className="nowrap small muted">{fecha(fila.created_at)}</td>
                    <td>{fila.user_name}</td>
                    <td className="small">
                      {fila.action}
                      {fila.target && ` · ${fila.target}`}
                      {fila.detail && <span className="muted"> ({fila.detail})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {auditoria && (
          <Paginador
            desde={auditoria.desde}
            limite={auditoria.limite}
            total={auditoria.total}
            hayMas={auditoria.hay_mas}
            onCambiar={setDesde}
          />
        )}
      </Card>

      {alta && (
        <FormularioAlta
          onClose={() => setAlta(false)}
          onListo={() => {
            setAlta(false);
            refrescar();
          }}
        />
      )}
      {editando && (
        <FormularioEdicion
          usuario={editando}
          esYo={editando.id === yo}
          onClose={() => setEditando(null)}
          onListo={() => {
            setEditando(null);
            refrescar();
          }}
        />
      )}
    </div>
  );
}

function FormularioAlta({ onClose, onListo }: { onClose: () => void; onListo: () => void }) {
  const ejecutar = useAction();
  const [name, setName] = useState('');
  const [usuario, setUsuario] = useState('');
  const [clave, setClave] = useState('');
  const [role, setRole] = useState<Rol>('cocina');

  const listo = name.trim() && usuario.trim().length >= 3 && clave.length >= 8;

  return (
    <Modal
      title="Dar de alta"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!listo}
          onClick={async () => {
            const ok = await ejecutar(
              () => api.post('/usuarios', { name: name.trim(), usuario: usuario.trim(), clave, role }),
              `${name.trim()} ya puede entrar`,
            );
            if (ok) onListo();
          }}
        >
          Crear
        </button>
      }
    >
      <Field label="Nombre">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label="Usuario" hint="Con lo que va a entrar. Sin espacios.">
        <input className="input" value={usuario} onChange={(e) => setUsuario(e.target.value)} />
      </Field>
      <Field label="Clave" hint="Al menos 8 caracteres. Decísela en persona; después la puede cambiar.">
        <input
          className="input"
          type="password"
          value={clave}
          onChange={(e) => setClave(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <SelectorDeRol valor={role} onChange={setRole} />
    </Modal>
  );
}

function FormularioEdicion({
  usuario,
  esYo,
  onClose,
  onListo,
}: {
  usuario: Usuario;
  esYo: boolean;
  onClose: () => void;
  onListo: () => void;
}) {
  const ejecutar = useAction();
  const [name, setName] = useState(usuario.name);
  const [role, setRole] = useState<Rol>(usuario.role);
  const [clave, setClave] = useState('');

  return (
    <Modal
      title={`Editar a ${usuario.name}`}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            const cambio: Record<string, unknown> = { name: name.trim() };
            if (!esYo) cambio.role = role;
            if (clave) cambio.clave = clave;
            const ok = await ejecutar(
              () => api.patch(`/usuarios/${usuario.id}`, cambio),
              clave ? 'Clave cambiada: se cerraron sus sesiones' : 'Guardado',
            );
            if (ok) onListo();
          }}
        >
          Guardar
        </button>
      }
    >
      <Field label="Nombre">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {esYo ? (
        <p className="small muted">
          No podés cambiarte el rol a vos mismo: es la forma más fácil de quedarse afuera.
        </p>
      ) : (
        <SelectorDeRol valor={role} onChange={setRole} />
      )}
      <Field
        label="Clave nueva"
        hint="Dejala vacía para no tocarla. Cambiarla cierra todas sus sesiones abiertas."
      >
        <input
          className="input"
          type="password"
          value={clave}
          onChange={(e) => setClave(e.target.value)}
          autoComplete="new-password"
          placeholder="sin cambios"
        />
      </Field>
    </Modal>
  );
}

const SelectorDeRol = ({ valor, onChange }: { valor: Rol; onChange: (r: Rol) => void }) => (
  <Field label="Rol" hint={DESCRIPCION_ROL[valor]}>
    <select className="input" value={valor} onChange={(e) => onChange(e.target.value as Rol)}>
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  </Field>
);

const fecha = (iso: string) =>
  new Date(iso.replace(' ', 'T') + 'Z').toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
