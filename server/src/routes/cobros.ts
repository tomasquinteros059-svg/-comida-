import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { route } from '../lib/http.js';
import {
  MEDIOS,
  configMercadoPago,
  crearLinkDePago,
  desmarcarPagado,
  loQueFaltaDeMercadoPago,
  marcarPagado,
  mercadoPagoActivo,
  pagosDe,
  procesarAviso,
  resumenDeCaja,
  sinCobrar,
} from '../domain/cobros.js';

/** Lo que usa el local desde el panel. Va detras del guard de permisos. */
export const cobrosRouter = Router();

/** El aviso de Mercado Pago. Es publico: lo llama Mercado Pago. */
export const cobrosWebhookRouter = Router();

// ── Panel ───────────────────────────────────────────────────────────────────

cobrosRouter.get(
  '/estado',
  route(() => ({
    mercadopago: { activo: mercadoPagoActivo(), falta: loQueFaltaDeMercadoPago() },
    medios: MEDIOS,
  })),
);

/** Lo que falta cobrar hoy: la pregunta del cierre de caja. */
cobrosRouter.get('/pendientes', route(() => sinCobrar()));

cobrosRouter.get(
  '/caja',
  route((req) => {
    const fecha = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha va como AAAA-MM-DD')
      .optional()
      .parse(req.query.fecha ?? undefined);
    return resumenDeCaja(fecha);
  }),
);

cobrosRouter.get('/pedido/:id', route((req) => pagosDe(req.params.id!)));

const cobroManual = z.object({
  medio: z.enum(MEDIOS),
  detalle: z.string().max(300).optional(),
});

/** Lo que pasa en el mostrador: alguien pago y se registra. */
cobrosRouter.post(
  '/pedido/:id/pagado',
  route((req) => {
    const { medio, detalle } = cobroManual.parse(req.body ?? {});
    marcarPagado(req.params.id!, medio, detalle);
    return { ok: true };
  }),
);

/** Deshacer: se cobro el pedido equivocado, pasa. */
cobrosRouter.post(
  '/pedido/:id/sin-pagar',
  route((req) => {
    const { motivo } = z.object({ motivo: z.string().max(300).optional() }).parse(req.body ?? {});
    desmarcarPagado(req.params.id!, motivo);
    return { ok: true };
  }),
);

/** Link de Mercado Pago para el que paga antes de pasar a buscarlo. */
cobrosRouter.post('/pedido/:id/link', route((req) => crearLinkDePago(req.params.id!)));

// ── Webhook ─────────────────────────────────────────────────────────────────

/**
 * Mercado Pago firma sus avisos con un HMAC sobre un texto armado con el id del
 * pago, el id de la peticion y la marca de tiempo. Viene en la cabecera
 * `x-signature` como `ts=...,v1=...`.
 */
export function firmaDeMercadoPagoValida(
  cabeceraFirma: string | undefined,
  cabeceraPeticion: string | undefined,
  dataId: string,
): boolean {
  const { webhookSecret } = configMercadoPago();
  // Sin clave configurada no se acepta nada: es la unica cosa que separa un
  // aviso de Mercado Pago de cualquiera que conozca la URL.
  if (!webhookSecret || !cabeceraFirma) return false;

  const partes = Object.fromEntries(
    cabeceraFirma.split(',').map((p) => {
      const [k, ...v] = p.split('=');
      return [k?.trim() ?? '', v.join('=').trim()];
    }),
  );
  const ts = partes.ts;
  const v1 = partes.v1;
  if (!ts || !v1) return false;

  const plantilla = `id:${dataId};request-id:${cabeceraPeticion ?? ''};ts:${ts};`;
  const esperada = createHmac('sha256', webhookSecret).update(plantilla).digest('hex');

  const a = createHmac('sha256', 'comparacion').update(v1).digest();
  const b = createHmac('sha256', 'comparacion').update(esperada).digest();
  return timingSafeEqual(a, b);
}

/**
 * El aviso de pago.
 *
 * Se contesta 200 enseguida —Mercado Pago reintenta si tardamos— y el estado
 * real se pregunta a su API. Nunca se cree lo que dice el aviso: si no fuera
 * asi, cualquiera manda un "pagado" y se lleva la comida gratis.
 */
cobrosWebhookRouter.post('/webhook', (req, res) => {
  const cuerpo = (req.body ?? {}) as { type?: string; action?: string; data?: { id?: string | number } };
  const dataId = String(cuerpo.data?.id ?? req.query['data.id'] ?? '');

  if (!firmaDeMercadoPagoValida(req.header('x-signature'), req.header('x-request-id'), dataId)) {
    res.status(401).json({ error: 'Firma inválida' });
    return;
  }

  const esPago = cuerpo.type === 'payment' || String(req.query.type ?? '') === 'payment';
  res.status(200).json({ ok: true });

  if (!esPago || !dataId) return;

  void procesarAviso(dataId).then((r) => {
    if (!r.aplicado && r.motivo) console.error(`[cobros] aviso ${dataId}: ${r.motivo}`);
  });
});
