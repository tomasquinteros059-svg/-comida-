import { all, get, run, transaction } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/http.js';
import { emit } from '../lib/events.js';
import { getOrderOrThrow } from './orders.js';

/**
 * Cobros.
 *
 * El pedido llega a la cocina igual que siempre; esto cierra el círculo del
 * otro lado. Dos formas, porque un local usa las dos:
 *
 *   - A mano: "pagó en efectivo", "pagó con débito". Es la mayoría de lo que
 *     pasa en un mostrador y no necesita ninguna integración.
 *   - Con link de Mercado Pago, para el que pide por el chat y paga antes de
 *     pasar a buscarlo.
 *
 * El estado del pago va aparte del estado del pedido a propósito: un pedido
 * puede estar entregado y sin pagar (la cuenta que se paga al final) o pagado
 * y sin cocinar (el que pagó por link antes de llegar). Mezclarlos obligaría a
 * inventar estados como "listo-pero-impago" que no le sirven a nadie.
 */

export const ESTADOS_DE_PAGO = ['sin_pagar', 'pendiente', 'pagado', 'devuelto'] as const;
export type EstadoDePago = (typeof ESTADOS_DE_PAGO)[number];

export const MEDIOS = ['efectivo', 'debito', 'credito', 'transferencia', 'mercadopago', 'otro'] as const;
export type Medio = (typeof MEDIOS)[number];

export interface Pago {
  id: string;
  order_id: string;
  proveedor: string;
  estado: string;
  monto_cents: number;
  referencia: string | null;
  link: string;
  detalle: string;
  created_at: string;
  updated_at: string;
}

// ── Configuración ───────────────────────────────────────────────────────────

/**
 * Las credenciales van por entorno y no en la base: la base se respalda y esas
 * copias circulan. Un token de Mercado Pago dentro de un backup deja cobrar en
 * nombre del local.
 */
export const configMercadoPago = () => ({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN?.trim() ?? '',
  /** Con esto se verifica que el aviso lo mandó Mercado Pago y no cualquiera. */
  webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim() ?? '',
  /** A dónde vuelve el cliente después de pagar. */
  urlBase: process.env.PUBLIC_URL?.trim() ?? '',
});

export const mercadoPagoActivo = (): boolean => configMercadoPago().accessToken.length > 0;

export function loQueFaltaDeMercadoPago(): string[] {
  const c = configMercadoPago();
  const falta: string[] = [];
  if (!c.accessToken) falta.push('el token de Mercado Pago (MERCADOPAGO_ACCESS_TOKEN)');
  if (!c.webhookSecret) falta.push('la clave del webhook (MERCADOPAGO_WEBHOOK_SECRET)');
  if (!c.urlBase) falta.push('la dirección pública del local (PUBLIC_URL)');
  return falta;
}

// ── Cobro a mano ────────────────────────────────────────────────────────────

/**
 * Lo que pasa en el mostrador: alguien pagó y se registra. No hay integración
 * ni hay nada que esperar, y así es como se cobra casi siempre.
 */
export function marcarPagado(orderId: string, medio: Medio, detalle = ''): void {
  const order = getOrderOrThrow(orderId);
  if (!MEDIOS.includes(medio)) throw badRequest(`Medio de pago desconocido: ${medio}`);
  if (order.status === 'cancelado') throw badRequest('Un pedido cancelado no se cobra');

  transaction(() => {
    run(
      `UPDATE orders SET payment_status = 'pagado', payment_method = ?, paid_at = datetime('now')
       WHERE id = ?`,
      [medio, orderId],
    );
    run(
      `INSERT INTO pagos (id, order_id, proveedor, estado, monto_cents, detalle)
       VALUES (?,?,?,'aprobado',?,?)`,
      [newId('pag'), orderId, medio, order.total_cents, detalle],
    );
  });
  emit('pedido', `${order.code} pagado`);
}

/** Deshacer: se cobró el pedido equivocado, pasa. */
export function desmarcarPagado(orderId: string, motivo = ''): void {
  const order = getOrderOrThrow(orderId);
  transaction(() => {
    run(
      `UPDATE orders SET payment_status = 'sin_pagar', payment_method = '', paid_at = NULL WHERE id = ?`,
      [orderId],
    );
    run(
      `INSERT INTO pagos (id, order_id, proveedor, estado, monto_cents, detalle)
       VALUES (?,?,'ajuste','devuelto',?,?)`,
      [newId('pag'), orderId, order.total_cents, motivo || 'Se deshizo el cobro'],
    );
  });
  emit('pedido', `${order.code} sin pagar`);
}

export const pagosDe = (orderId: string): Pago[] =>
  all<Pago>('SELECT * FROM pagos WHERE order_id = ? ORDER BY created_at', [orderId]);

// ── Link de pago ────────────────────────────────────────────────────────────

export interface LinkDePago {
  pago_id: string;
  link: string;
  referencia: string;
}

/**
 * Arma un link de pago de Mercado Pago para un pedido.
 *
 * `external_reference` lleva el id del pedido: es lo que permite reconocer de
 * qué pedido habla el aviso cuando vuelve, sin tener que confiar en nada que
 * venga del navegador del cliente.
 */
export async function crearLinkDePago(orderId: string): Promise<LinkDePago> {
  const c = configMercadoPago();
  if (!c.accessToken) throw badRequest('Mercado Pago no está configurado');

  const order = getOrderOrThrow(orderId);
  if (order.status === 'cancelado') throw badRequest('Un pedido cancelado no se cobra');
  if (order.payment_status === 'pagado') throw badRequest('Ese pedido ya está pagado');
  if (order.total_cents <= 0) throw badRequest('El pedido no tiene importe');

  const pagoId = newId('pag');
  const respuesta = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${c.accessToken}`,
      // Si el local aprieta dos veces, Mercado Pago devuelve el mismo link en
      // vez de crear dos cobros por el mismo pedido.
      'X-Idempotency-Key': pagoId,
    },
    body: JSON.stringify({
      items: order.items.map((item) => ({
        title: item.product_name,
        quantity: item.qty,
        unit_price: item.unit_price_cents / 100,
        currency_id: 'ARS',
      })),
      external_reference: order.id,
      notification_url: c.urlBase ? `${c.urlBase}/api/cobros/webhook` : undefined,
      back_urls: c.urlBase ? { success: c.urlBase, failure: c.urlBase, pending: c.urlBase } : undefined,
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text().catch(() => '');
    throw badRequest(`Mercado Pago no aceptó el cobro (${respuesta.status}): ${detalle.slice(0, 250)}`);
  }

  const datos = (await respuesta.json()) as { id?: string; init_point?: string; sandbox_init_point?: string };
  const link = datos.init_point ?? datos.sandbox_init_point ?? '';
  if (!link) throw badRequest('Mercado Pago no devolvió un link de pago');

  transaction(() => {
    run(
      `INSERT INTO pagos (id, order_id, proveedor, estado, monto_cents, referencia, link)
       VALUES (?,?,'mercadopago','pendiente',?,?,?)`,
      [pagoId, order.id, order.total_cents, datos.id ?? null, link],
    );
    run("UPDATE orders SET payment_status = 'pendiente', payment_method = 'mercadopago' WHERE id = ?", [
      order.id,
    ]);
  });

  emit('pedido', `${order.code} esperando pago`);
  return { pago_id: pagoId, link, referencia: datos.id ?? '' };
}

// ── El aviso de Mercado Pago ────────────────────────────────────────────────

/**
 * Procesa un aviso de pago.
 *
 * NUNCA se cree lo que dice el aviso. El webhook trae un id y nada más; el
 * estado real se pregunta a la API de Mercado Pago. Si no fuera así, cualquiera
 * que sepa la URL manda un "pagado" y se lleva la comida gratis.
 */
export async function procesarAviso(paymentId: string): Promise<{ aplicado: boolean; motivo?: string }> {
  const c = configMercadoPago();
  if (!c.accessToken) return { aplicado: false, motivo: 'Mercado Pago no está configurado' };

  const respuesta = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { authorization: `Bearer ${c.accessToken}` },
  });
  if (!respuesta.ok) {
    return { aplicado: false, motivo: `No pude consultar el pago ${paymentId} (${respuesta.status})` };
  }

  const pago = (await respuesta.json()) as {
    id?: number | string;
    status?: string;
    external_reference?: string;
    transaction_amount?: number;
  };

  const orderId = pago.external_reference;
  if (!orderId) return { aplicado: false, motivo: 'El pago no dice de qué pedido es' };

  const order = get<{ id: string; code: string; total_cents: number; payment_status: string }>(
    'SELECT id, code, total_cents, payment_status FROM orders WHERE id = ?',
    [orderId],
  );
  if (!order) return { aplicado: false, motivo: `No existe el pedido ${orderId}` };

  const estado = mapearEstado(pago.status ?? '');
  const montoCents = Math.round((pago.transaction_amount ?? 0) * 100);

  // Si el monto no coincide con el pedido, no se da por pagado: se registra y
  // se deja para que alguien lo mire. Un pago de $1 sobre un pedido de $10.000
  // es un intento de llevarse la comida, no un error de redondeo.
  const montoCoincide = Math.abs(montoCents - order.total_cents) <= 100;

  transaction(() => {
    const existente = get<{ id: string }>('SELECT id FROM pagos WHERE referencia = ?', [String(pago.id)]);
    if (existente) {
      run("UPDATE pagos SET estado = ?, updated_at = datetime('now') WHERE id = ?", [estado, existente.id]);
    } else {
      run(
        `INSERT INTO pagos (id, order_id, proveedor, estado, monto_cents, referencia, detalle)
         VALUES (?,?,'mercadopago',?,?,?,?)`,
        [newId('pag'), order.id, estado, montoCents, String(pago.id ?? ''), pago.status ?? ''],
      );
    }

    if (estado === 'aprobado' && montoCoincide) {
      run(
        `UPDATE orders SET payment_status = 'pagado', payment_method = 'mercadopago',
                           payment_ref = ?, paid_at = datetime('now')
         WHERE id = ?`,
        [String(pago.id ?? ''), order.id],
      );
    } else if (estado === 'devuelto') {
      run("UPDATE orders SET payment_status = 'devuelto' WHERE id = ?", [order.id]);
    }
  });

  if (estado === 'aprobado' && !montoCoincide) {
    emit('pedido', `${order.code} pago con monto distinto`);
    return {
      aplicado: false,
      motivo:
        `El pago dice $${(montoCents / 100).toLocaleString('es-AR')} y el pedido es de ` +
        `$${(order.total_cents / 100).toLocaleString('es-AR')}. Quedó registrado sin darlo por pagado.`,
    };
  }

  emit('pedido', `${order.code} ${estado}`);
  return { aplicado: true };
}

/** Los estados de Mercado Pago, traducidos a los cuatro que le importan al local. */
export function mapearEstado(estadoMp: string): string {
  switch (estadoMp) {
    case 'approved':
      return 'aprobado';
    case 'refunded':
    case 'charged_back':
      return 'devuelto';
    case 'cancelled':
    case 'rejected':
      return 'rechazado';
    default:
      return 'pendiente';
  }
}

// ── Lo que ve el local ──────────────────────────────────────────────────────

/** Lo que falta cobrar hoy: la pregunta del cierre de caja. */
export function sinCobrar() {
  const filas = all<{ id: string; code: string; daily_number: number; total_cents: number; created_at: string; channel: string }>(
    `SELECT id, code, daily_number, total_cents, created_at, channel FROM orders
     WHERE payment_status IN ('sin_pagar', 'pendiente')
       AND status NOT IN ('cancelado', 'borrador')
       AND date(created_at) = date('now')
     ORDER BY created_at`,
  );
  return {
    pedidos: filas,
    total_cents: filas.reduce((suma, f) => suma + f.total_cents, 0),
  };
}

export function resumenDeCaja(fecha?: string) {
  const dia = fecha ?? new Date().toISOString().slice(0, 10);
  const porMedio = all<{ payment_method: string; pedidos: number; total_cents: number }>(
    `SELECT payment_method, COUNT(*) AS pedidos, SUM(total_cents) AS total_cents
     FROM orders
     WHERE payment_status = 'pagado' AND date(paid_at) = ?
     GROUP BY payment_method ORDER BY total_cents DESC`,
    [dia],
  );
  const pendiente = sinCobrar();
  return {
    fecha: dia,
    por_medio: porMedio,
    cobrado_cents: porMedio.reduce((s, f) => s + f.total_cents, 0),
    sin_cobrar_cents: pendiente.total_cents,
    sin_cobrar: pendiente.pedidos.length,
  };
}
