import type { NextFunction, Request, Response } from 'express';
import {
  SLUG_POR_DEFECTO,
  enLocal,
  listarLocales,
  localPorHost,
  obtenerLocal,
} from '../db/locales.js';
import { HttpError } from './http.js';

/**
 * Resuelve a qué local pertenece cada pedido y lo corre en su contexto.
 *
 * Por el dominio con el que entraron, que es lo natural: `laesquina.com.ar` y
 * `donjose.com.ar` apuntan al mismo servidor y cada uno ve lo suyo. Hasta que
 * alguien da de alta un segundo local, todo esto es transparente: hay un solo
 * local y se llama "principal".
 */
export function resolverLocal(req: Request, res: Response, next: NextFunction): void {
  const locales = listarLocales();

  // Instalación de un solo local: nada que resolver, como fue siempre.
  if (locales.length <= 1) {
    enLocal(locales[0]?.slug ?? SLUG_POR_DEFECTO, () => next());
    return;
  }

  const porDominio = localPorHost(req.hostname || req.header('host') || '');

  // Una cabecera para poder trabajar contra un local sin montar su dominio.
  // Solo sirve si el local existe, así que no abre nada: quien ya está
  // adentro del panel puede ver otro local, pero para eso hay que entrar
  // primero, y cada local tiene sus propios usuarios y sus propias claves.
  const porCabecera = req.header('x-local');

  /**
   * Mientras el principal no tenga dominios propios, atiende todo lo que no
   * coincide con ningún otro.
   *
   * Sin esto, dar de alta el segundo local tira abajo al primero: el local que
   * venía andando por IP o por un dominio que nadie cargó empieza a devolver
   * 404 de un momento para el otro, y nadie relaciona una cosa con la otra.
   * Cuando el principal SÍ tiene sus dominios, quiere decir que alguien
   * configuró el ruteo a propósito y ahí un dominio desconocido es un error.
   */
  const principal = obtenerLocal(SLUG_POR_DEFECTO);
  const principalEsElComodin = Boolean(principal?.activo && principal.hosts.length === 0);

  const elegido =
    porDominio ??
    (porCabecera ? obtenerLocal(porCabecera) : undefined) ??
    (principalEsElComodin ? principal : undefined);

  if (!elegido) {
    next(
      new HttpError(
        404,
        `No hay ningún local en "${req.hostname}". Revisá que el dominio esté cargado en Locales.`,
      ),
    );
    return;
  }

  if (!elegido.activo) {
    next(new HttpError(503, `${elegido.nombre} está desactivado`));
    return;
  }

  res.set('X-Local', elegido.slug);
  enLocal(elegido.slug, () => next());
}
