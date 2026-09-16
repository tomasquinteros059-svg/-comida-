import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('config');

/**
 * Los límites que vienen del entorno.
 *
 * Esto existe por un bug que casi sale: `docker compose` pasa las variables no
 * definidas como CADENA VACÍA, no como ausentes. `Number(process.env.X ?? 5)`
 * cubre el caso "no está" y no cubre el caso "está vacía": `Number('')` da
 * cero, y un límite de intentos en cero deja el panel cerrado para todos, con
 * un mensaje —"demasiados intentos"— que manda a buscar el problema al lado
 * equivocado.
 *
 * El mismo agujero dejaba al chatbot rechazando todos los mensajes del local.
 */
describe('los números que vienen del entorno', () => {
  const conEntorno = async (vars: Record<string, string | undefined>) => {
    const guardado: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      guardado[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // El módulo se lee una vez, así que cada caso pide su propia copia.
    const { config } = await import(`../config.js?caso=${Math.random()}`);
    for (const [k, v] of Object.entries(guardado)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return config as typeof import('../config.js').config;
  };

  it('una variable vacía vale lo mismo que una que no está', async () => {
    const vacio = await conEntorno({ LOGIN_RATE_MAX: '', CHAT_RATE_MAX: '', CHAT_RATE_WINDOW_MS: '' });
    assert.equal(vacio.loginRateMax, 5, 'con el límite en cero no entra nadie al panel');
    assert.equal(vacio.chatRateLimit.max, 20, 'con el límite en cero el bot no contesta a nadie');
    assert.equal(vacio.chatRateLimit.windowMs, 60_000);
  });

  it('una variable mal escrita a mano tampoco apaga el límite', async () => {
    const roto = await conEntorno({ LOGIN_RATE_MAX: 'cinco', CHAT_RATE_MAX: '  ' });
    assert.equal(roto.loginRateMax, 5);
    assert.equal(roto.chatRateLimit.max, 20);
  });

  it('un cero explícito tampoco: para un límite, cero es un error de tipeo', async () => {
    const cero = await conEntorno({ LOGIN_RATE_MAX: '0' });
    assert.equal(cero.loginRateMax, 5);
  });

  it('pero un número de verdad se respeta', async () => {
    const puesto = await conEntorno({ LOGIN_RATE_MAX: '25', CHAT_RATE_MAX: '3' });
    assert.equal(puesto.loginRateMax, 25);
    assert.equal(puesto.chatRateLimit.max, 3);
  });

  it('en TRUST_PROXY el cero sí es una respuesta, no un error', async () => {
    // Acá cero significa "el proceso mira a internet directo, no confíes en
    // ningún X-Forwarded-For". Es lo contrario de un límite en cero.
    const directo = await conEntorno({ TRUST_PROXY: '0' });
    assert.equal(directo.trustProxy, 0);
    const detrasDeProxy = await conEntorno({ TRUST_PROXY: '1' });
    assert.equal(detrasDeProxy.trustProxy, 1);
    const vacio = await conEntorno({ TRUST_PROXY: '' });
    assert.equal(vacio.trustProxy, 0, 'sin decir nada, lo seguro es no confiar');
  });

  it('los textos vacíos también caen al valor por omisión', async () => {
    const vacio = await conEntorno({ CURRENCY: '', TIMEZONE: '', CHAT_MODEL: '' });
    assert.equal(vacio.currency, 'ARS');
    assert.equal(vacio.timezone, 'America/Argentina/Buenos_Aires');
    assert.equal(vacio.chatModel, 'claude-opus-5');
  });
});
