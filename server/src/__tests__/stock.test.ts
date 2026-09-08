import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('stock');

const { alertLevel } = await import('../domain/stock.js');

describe('severidad de las alertas de stock', () => {
  const ing = (stock_qty: number, min_qty: number) => ({ stock_qty, min_qty });

  it('marca agotado lo que llego a cero', () => {
    assert.equal(alertLevel(ing(0, 5), 0), 'agotado');
    assert.equal(alertLevel(ing(-1, 5), null), 'agotado');
  });

  it('sin consumo medido usa solo el punto de reposicion', () => {
    assert.equal(alertLevel(ing(4, 5), null), 'critico');
    assert.equal(alertLevel(ing(7, 5), null), 'bajo');
    assert.equal(alertLevel(ing(20, 5), null), null);
  });

  it('baja la urgencia de lo que igual dura una semana', () => {
    // En el minimo, pero con 133 dias de cobertura: no es una urgencia.
    assert.equal(alertLevel(ing(2, 2), 133), 'bajo');
    assert.equal(alertLevel(ing(2, 2), 7), 'bajo');
  });

  it('mantiene critico lo que esta en el minimo y se acaba pronto', () => {
    assert.equal(alertLevel(ing(2, 2), 3), 'critico');
  });

  it('marca critico lo que se acaba manana aunque este sobre el minimo', () => {
    // El minimo esta mal calibrado: 30 unidades no alcanzan ni para dos dias.
    assert.equal(alertLevel(ing(30, 5), 1.5), 'critico');
  });

  it('avisa de lo que dura menos de cinco dias aunque el minimo no lo detecte', () => {
    assert.equal(alertLevel(ing(30, 5), 4), 'bajo');
  });

  it('no alerta de lo que esta holgado', () => {
    assert.equal(alertLevel(ing(100, 5), 30), null);
  });
});
