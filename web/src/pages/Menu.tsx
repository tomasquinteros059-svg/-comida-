import { useMemo, useState } from 'react';
import { useApi } from '../lib/useApi';
import { api } from '../lib/api';
import { useAction } from '../lib/toast';
import type { Category, LaggingProduct, MenuItemPerformance, Product } from '../lib/types';
import { Badge, Card, Empty, Field, Modal, Spinner, Switch } from '../components/ui';
import { money, moneyExact } from '../lib/format';

const CLASS_TONE = {
  estrella: 'ok',
  vaca: 'info',
  enigma: 'warn',
  perro: 'danger',
} as const;

const CLASS_HELP: Record<string, string> = {
  estrella: 'Se vende mucho y deja buen margen',
  vaca: 'Se vende mucho pero deja poco',
  enigma: 'Deja buen margen pero casi no se pide',
  perro: 'Poco volumen y poco margen',
};

interface MenuResponse {
  categories: Category[];
  products: Product[];
}

export function MenuPage() {
  const menu = useApi<MenuResponse>('/menu?all=1');
  const performance = useApi<MenuItemPerformance[]>('/menu-performance?days=30');
  const lagging = useApi<LaggingProduct[]>('/lagging?days=30');
  const run = useAction();

  const [editing, setEditing] = useState<Product | 'nuevo' | null>(null);
  const [filter, setFilter] = useState('');

  const stats = useMemo(
    () => new Map((performance.data ?? []).map((p) => [p.product_id, p])),
    [performance.data],
  );

  const reloadAll = async () => {
    await Promise.all([menu.reload(), performance.reload(), lagging.reload()]);
  };

  const toggleAvailability = (product: Product) =>
    void run(async () => {
      // `available_override` fija la decision del local: la sincronizacion
      // automatica por stock deja de tocar este producto.
      await api.patch(`/menu/products/${product.id}`, {
        available: !product.available,
        available_override: !product.available,
      });
      await reloadAll();
    }, `${product.name}: ${product.available ? 'sin disponibilidad' : 'disponible'}`);

  const clearOverride = (product: Product) =>
    void run(async () => {
      await api.patch(`/menu/products/${product.id}`, { available_override: null });
      await api.post('/stock/sync-availability');
      await reloadAll();
    }, 'Vuelve a manejarse por stock');

  const toggleActive = (product: Product) =>
    void run(async () => {
      await api.patch(`/menu/products/${product.id}`, { active: !product.active });
      await reloadAll();
    }, `${product.name}: ${product.active ? 'fuera de la carta' : 'en la carta'}`);

  if (menu.error) return <div className="banner danger">No pude cargar la carta: {menu.error}</div>;
  if (!menu.data) return <Spinner />;

  const query = filter.trim().toLowerCase();
  const products = menu.data.products.filter(
    (p) => !query || p.name.toLowerCase().includes(query) || (p.category_name ?? '').toLowerCase().includes(query),
  );

  const byCategory = new Map<string, Product[]>();
  for (const product of products) {
    const key = product.category_name ?? 'Sin categoria';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(product);
  }

  return (
    <div className="stack">
      {!!lagging.data?.length && (
        <Card
          title={`Productos que se estan quedando atras (${lagging.data.length})`}
          action={<span className="small faint">ultimos 30 dias</span>}
          tight
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="num">Unidades</th>
                  <th className="num">Margen</th>
                  <th>Que pasa</th>
                  <th>Sugerencia</th>
                </tr>
              </thead>
              <tbody>
                {lagging.data.map((item) => (
                  <tr key={item.product_id}>
                    <td className="strong">{item.name}</td>
                    <td className="num">{item.qty}</td>
                    <td className="num">{money(item.margin_cents)}</td>
                    <td className="small muted">{item.reason}</td>
                    <td className="small">{item.recommendation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card
        title="Carta"
        action={
          <div className="row tight">
            <input
              className="input"
              style={{ width: 180 }}
              placeholder="Buscar…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button className="btn primary small" onClick={() => setEditing('nuevo')}>
              + Producto
            </button>
          </div>
        }
        tight
      >
        {!products.length && <Empty icon="☰">No hay productos que coincidan</Empty>}

        {!!products.length && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th className="num">Precio</th>
                  <th className="num">Costo</th>
                  <th className="num">Margen</th>
                  <th className="num">30 d</th>
                  <th>Clasificacion</th>
                  <th>Disponible</th>
                  <th />
                </tr>
              </thead>
              {[...byCategory.entries()].map(([categoryName, items]) => (
                <tbody key={categoryName}>
                  <tr className="group-row">
                    <td colSpan={8}>
                      {categoryName} <span className="faint">· {items.length}</span>
                    </td>
                  </tr>
                  {items.map((product) => {
                    const stat = stats.get(product.id);
                    const margin = product.price_cents - product.cost_cents;
                    return (
                      <tr key={product.id} style={{ opacity: product.active ? 1 : 0.5 }}>
                        <td>
                          <div className="strong">{product.name}</div>
                          <div className="small muted">{product.description}</div>
                          {!!product.tags.length && (
                            <div className="row tight" style={{ marginTop: 4 }}>
                              {product.tags.map((tag) => (
                                <Badge key={tag}>{tag}</Badge>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="num nowrap">{moneyExact(product.price_cents)}</td>
                        <td className="num nowrap muted">{moneyExact(product.cost_cents)}</td>
                        <td className="num nowrap">
                          {money(margin)}
                          <div className="small faint">
                            {product.price_cents ? `${Math.round((margin / product.price_cents) * 100)}%` : '—'}
                          </div>
                        </td>
                        <td className="num">{stat?.qty ?? 0}</td>
                        <td>
                          {stat && (
                            <Badge tone={CLASS_TONE[stat.classification]}>
                              <span title={CLASS_HELP[stat.classification]}>{stat.classification}</span>
                            </Badge>
                          )}
                        </td>
                        <td>
                          <div className="row tight inline">
                            <Switch
                              on={product.available}
                              onChange={() => toggleAvailability(product)}
                              label={`Disponibilidad de ${product.name}`}
                            />
                            {product.available_override !== null && (
                              <button
                                className="btn ghost small"
                                title="Definido a mano. Volver a que lo maneje el stock."
                                onClick={() => clearOverride(product)}
                              >
                                &#128274;
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="nowrap">
                          <button className="btn ghost small" onClick={() => setEditing(product)}>
                            Editar
                          </button>
                          <button className="btn ghost small" onClick={() => toggleActive(product)}>
                            {product.active ? 'Sacar' : 'Reponer'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <ProductEditor
          product={editing === 'nuevo' ? null : editing}
          categories={menu.data.categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reloadAll();
          }}
        />
      )}
    </div>
  );
}

function ProductEditor({
  product,
  categories,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const run = useAction();
  const [form, setForm] = useState({
    name: product?.name ?? '',
    description: product?.description ?? '',
    category_id: product?.category_id ?? categories[0]?.id ?? '',
    price: product ? String(product.price_cents / 100) : '',
    cost: product ? String(product.cost_cents / 100) : '0',
    prep_minutes: product ? String(Math.round(product.prep_seconds / 60)) : '10',
    tags: (product?.tags ?? []).join(', '),
    allergens: (product?.allergens ?? []).join(', '),
  });

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const parseList = (value: string) =>
    value.split(',').map((v) => v.trim()).filter(Boolean);

  const save = () =>
    void run(async () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim(),
        category_id: form.category_id || null,
        price_cents: Math.round(Number(form.price) * 100),
        cost_cents: Math.round(Number(form.cost || 0) * 100),
        prep_seconds: Math.round(Number(form.prep_minutes || 10) * 60),
        tags: parseList(form.tags),
        allergens: parseList(form.allergens),
      };
      if (product) await api.patch(`/menu/products/${product.id}`, body);
      else await api.post('/menu/products', body);
      onSaved();
    }, product ? 'Producto actualizado' : 'Producto agregado');

  const valid = form.name.trim().length > 0 && Number(form.price) > 0;

  return (
    <Modal
      title={product ? `Editar ${product.name}` : 'Nuevo producto'}
      onClose={onClose}
      footer={
        <div className="row" style={{ width: '100%' }}>
          <span className="small faint">
            El chatbot toma estos datos al instante: no hace falta reiniciar nada.
          </span>
          <div className="row tight" style={{ marginLeft: 'auto' }}>
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" onClick={save} disabled={!valid}>Guardar</button>
          </div>
        </div>
      }
    >
      <div className="stack">
        <Field label="Nombre">
          <input className="input" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Descripcion" hint="El bot la usa para explicar el plato y para buscarlo.">
          <textarea className="textarea" value={form.description} onChange={set('description')} />
        </Field>
        <div className="grid cols-3">
          <Field label="Categoria">
            <select className="select" value={form.category_id} onChange={set('category_id')}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Precio de venta">
            <input className="input" type="number" min="0" step="1" value={form.price} onChange={set('price')} />
          </Field>
          <Field label="Costo del plato" hint="Se usa para el margen.">
            <input className="input" type="number" min="0" step="1" value={form.cost} onChange={set('cost')} />
          </Field>
        </div>
        <div className="grid cols-3">
          <Field label="Minutos de preparacion">
            <input className="input" type="number" min="1" value={form.prep_minutes} onChange={set('prep_minutes')} />
          </Field>
          <Field label="Etiquetas" hint="vegetariano, picante…">
            <input className="input" value={form.tags} onChange={set('tags')} />
          </Field>
          <Field label="Alergenos" hint="gluten, lacteos…">
            <input className="input" value={form.allergens} onChange={set('allergens')} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
