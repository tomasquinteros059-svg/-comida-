import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('procurement');

const { closeDb } = await import('../db/index.js');
const { createIngredient, getIngredient } = await import('../domain/stock.js');
const { run } = await import('../db/index.js');
const {
  advancePurchaseOrder,
  bestOffer,
  createSupplier,
  planReplenishment,
  purchaseOrderMessage,
  setSupplierPrice,
} = await import('../domain/procurement.js');

let cheese: string;
let flour: string;
let cheap: string;
let fast: string;

before(() => {
  // Queda por debajo del minimo: entra en la cola de reposicion.
  cheese = createIngredient({ name: 'Mozzarella', unit: 'kg', stock_qty: 1, min_qty: 4, par_qty: 12 }).id;
  flour = createIngredient({ name: 'Harina', unit: 'kg', stock_qty: 30, min_qty: 5, par_qty: 40 }).id;

  cheap = createSupplier({ name: 'Mayorista', lead_time_hours: 48, express: false }).id;
  fast = createSupplier({ name: 'Express', lead_time_hours: 3, express: true }).id;

  setSupplierPrice({ supplier_id: cheap, ingredient_id: cheese, price_cents: 80_000, pack_size: 10 });
  setSupplierPrice({ supplier_id: fast, ingredient_id: cheese, price_cents: 95_000, pack_size: 10 });
});

after(() => closeDb());

describe('eleccion de proveedor', () => {
  it('con plazo normal prioriza el precio', () => {
    const offer = bestOffer(cheese, 'normal');
    assert.equal(offer!.supplier.name, 'Mayorista');
    assert.equal(offer!.unit_cents, 8_000);
  });

  it('con urgencia express descarta al que no llega a tiempo', () => {
    assert.equal(bestOffer(cheese, 'express')!.supplier.name, 'Express');
    assert.equal(bestOffer(cheese, 'inmediato')!.supplier.name, 'Express');
  });

  it('sin proveedores devuelve null', () => {
    assert.equal(bestOffer(flour, 'express'), null);
  });
});

describe('plan de reposicion', () => {
  it('arma una orden por proveedor y compra por packs completos', () => {
    const plan = planReplenishment({ urgency: 'express' });
    assert.equal(plan.purchase_orders.length, 1);

    const po = plan.purchase_orders[0]!;
    assert.equal(po.supplier_name, 'Express');
    assert.equal(po.status, 'borrador');
    // Faltan 11 kg para llegar a 12; el pack es de 10, asi que se piden 20.
    assert.equal(po.items[0]!.qty, 20);
    assert.equal(po.total_cents, 190_000);
  });

  it('no vuelve a pedir lo que ya viene en camino', () => {
    // El plan anterior ya dejo una orden de mozzarella en borrador. Apretar
    // "reponer" de nuevo no puede pedir otros 20 kg: el local termina con el
    // doble de mercaderia porque alguien dudo si habia hecho clic.
    const segundo = planReplenishment({ urgency: 'express', ingredientIds: [cheese] });
    assert.equal(segundo.purchase_orders.length, 0);
    assert.equal(segundo.already_ordered[0]?.ingredient_name, 'Mozzarella');
    assert.equal(segundo.already_ordered[0]?.pending_qty, 20);
  });

  it('reporta los insumos sin proveedor en vez de ignorarlos', () => {
    const plan = planReplenishment({ urgency: 'express', ingredientIds: [flour] });
    assert.equal(plan.purchase_orders.length, 0);
    assert.equal(plan.unsourced[0]?.ingredient_name, 'Harina');
  });

  it('avisa cuando el unico proveedor no llega en el plazo pedido', () => {
    const plan = planReplenishment({ urgency: 'inmediato', ingredientIds: [cheese] });
    // Express entrega en 3 h y el plazo inmediato son 4 h: llega bien.
    assert.equal(plan.delayed.length, 0);

    const slowOnly = createSupplier({ name: 'Lento', lead_time_hours: 72 }).id;
    const oil = createIngredient({ name: 'Aceite', unit: 'l', stock_qty: 0, min_qty: 5, par_qty: 20 }).id;
    setSupplierPrice({ supplier_id: slowOnly, ingredient_id: oil, price_cents: 10_000, pack_size: 5 });

    const delayedPlan = planReplenishment({ urgency: 'express', ingredientIds: [oil] });
    assert.equal(delayedPlan.delayed[0]?.ingredient_name, 'Aceite');
    assert.equal(delayedPlan.delayed[0]?.lead_time_hours, 72);
    assert.match(delayedPlan.purchase_orders[0]!.note, /por encima del plazo pedido/);
  });
});

describe('recepcion de mercaderia', () => {
  /** Un insumo nuevo por prueba, para no arrastrar ordenes de las anteriores. */
  const conOrdenPropia = (nombre: string) => {
    const id = createIngredient({ name: nombre, unit: 'kg', stock_qty: 1, min_qty: 4, par_qty: 12 }).id;
    setSupplierPrice({ supplier_id: fast, ingredient_id: id, price_cents: 95_000, pack_size: 10 });
    const plan = planReplenishment({ urgency: 'express', ingredientIds: [id] });
    return { id, po: plan.purchase_orders[0]! };
  };

  it('suma al stock recien cuando la orden se marca recibida', () => {
    const { id, po } = conOrdenPropia('Provolone');
    const before = getIngredient(id)!.stock_qty;

    advancePurchaseOrder(po.id, 'enviada');
    assert.equal(getIngredient(id)!.stock_qty, before, 'enviar no mueve stock');

    advancePurchaseOrder(po.id, 'confirmada');
    advancePurchaseOrder(po.id, 'recibida');
    assert.equal(getIngredient(id)!.stock_qty, before + po.items[0]!.qty);
  });

  it('rechaza transiciones invalidas', () => {
    const { po } = conOrdenPropia('Roquefort');
    assert.throws(() => advancePurchaseOrder(po.id, 'recibida'), /No se puede pasar/);
  });

  it('una vez recibida, el insumo vuelve a poder pedirse', () => {
    const { id, po } = conOrdenPropia('Gruyere');
    // Mientras la orden esta en curso, no se repite.
    assert.equal(planReplenishment({ urgency: 'express', ingredientIds: [id] }).purchase_orders.length, 0);

    advancePurchaseOrder(po.id, 'enviada');
    advancePurchaseOrder(po.id, 'confirmada');
    advancePurchaseOrder(po.id, 'recibida');
    // Y si despues se vuelve a gastar, si.
    run('UPDATE ingredients SET stock_qty = 0 WHERE id = ?', [id]);
    assert.equal(planReplenishment({ urgency: 'express', ingredientIds: [id] }).purchase_orders.length, 1);
  });

  it('una orden cancelada no bloquea el proximo pedido', () => {
    const { id, po } = conOrdenPropia('Camembert');
    advancePurchaseOrder(po.id, 'cancelada');
    assert.equal(planReplenishment({ urgency: 'express', ingredientIds: [id] }).purchase_orders.length, 1);
  });
});

describe('mensaje al proveedor', () => {
  it('lista los insumos y el plazo pedido', () => {
    const nuevo = createIngredient({ name: 'Manteca', unit: 'kg', stock_qty: 0, min_qty: 4, par_qty: 12 }).id;
    setSupplierPrice({ supplier_id: fast, ingredient_id: nuevo, price_cents: 95_000, pack_size: 10 });
    const plan = planReplenishment({ urgency: 'inmediato', ingredientIds: [nuevo] });
    const po = plan.purchase_orders[0];
    if (!po) return;
    const message = purchaseOrderMessage(po.id);
    assert.match(message, /Manteca/);
    assert.match(message, /entrega inmediata/);
  });
});
