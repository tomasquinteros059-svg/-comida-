import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('hardening');

const { closeDb } = await import('../db/index.js');
const { config, configProblems } = await import('../config.js');
const { rateLimit } = await import('../lib/rateLimit.js');

const originalEnv = config.env;
const originalToken = config.adminToken;

after(() => {
  config.env = originalEnv;
  config.adminToken = originalToken;
  closeDb();
});

describe('control de configuración al arrancar', () => {
  beforeEach(() => {
    config.env = 'production';
    config.adminToken = '';
  });

  it('en desarrollo no exige nada', () => {
    config.env = 'development';
    assert.deepEqual(configProblems(), []);
  });

  it('en producción no deja arrancar con el panel abierto', () => {
    const problems = configProblems();
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /ADMIN_TOKEN/);
    assert.match(problems[0]!, /abierto/, 'tiene que decir por qué importa');
  });

  it('rechaza un token demasiado corto', () => {
    config.adminToken = 'corto';
    assert.match(configProblems()[0]!, /muy corto/);
  });

  it('acepta un token razonable', () => {
    config.adminToken = 'una-clave-larga-y-aleatoria-de-verdad';
    assert.deepEqual(configProblems(), []);
  });
});

describe('límite de pedidos', () => {
  /** Simula `n` pedidos de la misma IP y devuelve los errores devueltos. */
  const hit = (middleware: ReturnType<typeof rateLimit>, times: number, ip = '1.2.3.4') => {
    const errors: unknown[] = [];
    for (let i = 0; i < times; i++) {
      const res = { set: () => {} } as never;
      middleware({ ip } as never, res, ((err?: unknown) => {
        if (err) errors.push(err);
      }) as never);
    }
    return errors;
  };

  it('deja pasar hasta el máximo y corta después', () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 3 });
    assert.equal(hit(middleware, 3).length, 0, 'los primeros tres pasan');
    const errors = hit(middleware, 1);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as { status: number }).status, 429);
  });

  it('cuenta a cada IP por separado', () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 2 });
    hit(middleware, 2, '1.1.1.1');
    assert.equal(hit(middleware, 2, '2.2.2.2').length, 0, 'otra IP arranca de cero');
    assert.equal(hit(middleware, 1, '1.1.1.1').length, 1, 'la primera ya gastó su cupo');
  });

  it('libera el cupo cuando pasa la ventana', async () => {
    const middleware = rateLimit({ windowMs: 30, max: 1 });
    assert.equal(hit(middleware, 1).length, 0);
    assert.equal(hit(middleware, 1).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(hit(middleware, 1).length, 0, 'después de la ventana vuelve a pasar');
  });

  it('explica cuánto hay que esperar', () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    hit(middleware, 1);
    const error = hit(middleware, 1)[0] as Error;
    assert.match(error.message, /segundos/);
  });
});
