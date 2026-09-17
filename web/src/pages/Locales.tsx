import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAction } from '../lib/toast';
import { Badge, Card, Field, Modal, Spinner } from '../components/ui';

interface Local {
  slug: string;
  nombre: string;
  hosts: string[];
  whatsapp_id: string;
  activo: boolean;
  creado: string;
  archivo: string;
}

/**
 * Los locales de esta instalación.
 *
 * Cada uno tiene su propia base: su carta, sus pedidos, su facturación y sus
 * usuarios. No se comparte nada, y eso es a propósito.
 */
export function LocalesPage() {
  const { data, loading, reload } = useApi<{ locales: Local[]; actual: string; varios: boolean }>('/locales');
  const ejecutar = useAction();
  const [alta, setAlta] = useState(false);
  const [editando, setEditando] = useState<Local | null>(null);

  if (loading && !data) return <Spinner />;

  const cambiar = (local: Local, cambio: Record<string, unknown>, aviso: string) =>
    void ejecutar(async () => {
      await api.patch(`/locales/${local.slug}`, cambio);
      setEditando(null);
      await reload();
    }, aviso);

  return (
    <div className="stack">
      <Card
        title="Locales"
        action={
          <button className="btn primary small" onClick={() => setAlta(true)}>
            Sumar local
          </button>
        }
      >
        <p className="small muted" style={{ marginBottom: 14, maxWidth: '44rem' }}>
          Cada local tiene su propia base: su carta, sus pedidos, su facturación
          y sus usuarios. No se comparte nada. A cuál entra cada persona lo
          decide el dominio con el que abre el panel.
        </p>

        <div className="stack">
          {(data?.locales ?? []).map((l) => (
            <div key={l.slug} className={`usuario-fila${l.activo ? '' : ' usuario-inactivo'}`}>
              <div className="usuario-datos">
                <div className="usuario-nombre">
                  {l.nombre}
                  {l.slug === data?.actual && <span className="small muted"> · estás acá</span>}
                </div>
                <div className="usuario-alias">
                  {l.hosts.length ? l.hosts.join(', ') : 'sin dominio cargado'}
                  {l.whatsapp_id
                    ? ` · WhatsApp …${l.whatsapp_id.slice(-4)}`
                    : ''}
                </div>
              </div>
              {!l.activo && <Badge tone="danger">desactivado</Badge>}
              <div className="row-actions">
                <button className="btn ghost small" onClick={() => setEditando(l)}>
                  Editar
                </button>
                <button
                  className="btn ghost small"
                  onClick={() =>
                    cambiar(
                      l,
                      { activo: !l.activo },
                      l.activo ? `${l.nombre} dejó de atender` : `${l.nombre} vuelve a atender`,
                    )
                  }
                >
                  {l.activo ? 'Desactivar' : 'Activar'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {data && data.locales.length <= 1 && (
          <p className="small muted" style={{ marginTop: 14 }}>
            Con un solo local esto no cambia nada: todo sigue funcionando como
            siempre y no hace falta cargar ningún dominio.
          </p>
        )}
      </Card>

      {alta && (
        <FormularioDeLocal
          onClose={() => setAlta(false)}
          onListo={() => {
            setAlta(false);
            void reload();
          }}
        />
      )}
      {editando && (
        <FormularioDeLocal
          local={editando}
          onClose={() => setEditando(null)}
          onListo={() => {
            setEditando(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function FormularioDeLocal({
  local,
  onClose,
  onListo,
}: {
  local?: Local;
  onClose: () => void;
  onListo: () => void;
}) {
  const ejecutar = useAction();
  const [nombre, setNombre] = useState(local?.nombre ?? '');
  const [hosts, setHosts] = useState((local?.hosts ?? []).join('\n'));
  const [whatsapp, setWhatsapp] = useState(local?.whatsapp_id ?? '');

  const listaDeHosts = hosts
    .split(/[\n,]/)
    .map((h) => h.trim())
    .filter(Boolean);

  return (
    <Modal
      title={local ? `Editar ${local.nombre}` : 'Sumar un local'}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={nombre.trim().length < 2}
          onClick={async () => {
            const ok = await ejecutar(
              () =>
                local
                  ? api.patch(`/locales/${local.slug}`, {
                      nombre: nombre.trim(),
                      hosts: listaDeHosts,
                      whatsapp_id: whatsapp.trim(),
                    })
                  : api.post('/locales', { nombre: nombre.trim(), hosts: listaDeHosts }),
              local ? 'Guardado' : `${nombre.trim()} ya puede atender`,
            );
            if (ok) onListo();
          }}
        >
          {local ? 'Guardar' : 'Crear'}
        </button>
      }
    >
      <Field label="Nombre del local">
        <input
          id="local-nombre"
          className="input"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="Rotisería La Esquina"
          autoFocus
        />
      </Field>
      <Field
        label="Dominios"
        hint="Uno por renglón. Es lo que decide a qué local entra cada persona."
      >
        <textarea
          id="local-hosts"
          className="textarea"
          rows={3}
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
          placeholder={'laesquina.com.ar\npedidos.laesquina.com.ar'}
        />
      </Field>
      {local && (
        <Field
          label="Número de WhatsApp de este local"
          hint="El identificador del número (WHATSAPP_PHONE_NUMBER_ID), no el teléfono."
        >
          <input
            id="local-whatsapp"
            className="input"
            inputMode="numeric"
            value={whatsapp}
            onChange={(e) => setWhatsapp(e.target.value)}
            placeholder="123456789012345"
          />
          <p className="small muted" style={{ marginTop: 6 }}>
            Meta manda los mensajes de todos los locales a la misma dirección, así
            que esto es lo único que dice a qué cocina va cada pedido. Con un solo
            local se puede dejar vacío.
          </p>
        </Field>
      )}
      {!local && (
        <p className="small muted">
          Se crea una base vacía: carta, insumos y usuarios propios. Vas a tener
          que dar de alta el primer dueño de ese local por separado.
        </p>
      )}
    </Modal>
  );
}
