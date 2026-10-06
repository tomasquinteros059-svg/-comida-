import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('carta-orden');

/**
 * El orden de la carta y los modificadores de cada producto.
 *
 * Dos cosas que no probaba nadie y que el local toca seguido:
 *
 *   · el orden en que salen los productos. El local lo acomoda para que lo
 *     que más vende quede arriba, y es lo primero que ve el cliente en el
 *     chat. Si no se guarda, el acomodo se pierde al recargar y nadie
 *     entiende por qué;
 *   · qué grupo de modificadores tiene cada producto. Es de dónde sale que
 *     a una milanesa se le pueda sacar la cebolla. Sin el grupo enganchado,
 *     el bot no ofrece la opción y el pedido sale mal sin que falle nada.
 */

const { closeDb, run } = await import('../db/index.js');
const menu = await import('../domain/menu.js');

let categoria: string;

before(() => {
  categoria = menu.createCategory({ name: 'Milanesas' }).id;
});

after(() => closeDb());

const crear = (nombre: string) =>
  menu.createProduct({ name: nombre, category_id: categoria, price_cents: 500_000 }).id;

/** Los nombres, en el orden en que los devuelve la carta. */
const ordenActual = () =>
  menu.listProducts({ categoryId: categoria }).map((p) => p.name);

describe('el orden de la carta', () => {
  it('guarda el orden que mandó el local', () => {
    const napo = crear('Napolitana');
    const caballo = crear('A caballo');
    const simple = crear('Simple');

    menu.reorderProducts([simple, napo, caballo]);
    assert.deepEqual(ordenActual(), ['Simple', 'Napolitana', 'A caballo']);
  });

  it('el orden sobrevive a volver a leer la carta', () => {
    // Es el caso real: se acomoda, se recarga la pantalla, y tiene que
    // seguir como quedó. Si la posición no se guardara en la base, acá
    // volvería al orden alfabético.
    const antes = ordenActual();
    assert.deepEqual(ordenActual(), antes);
    assert.notDeepEqual(antes, [...antes].sort(), 'quedó en orden alfabético: no se guardó');
  });

  it('acomodar de nuevo pisa el orden anterior, no lo mezcla', () => {
    const ids = menu.listProducts({ categoryId: categoria }).map((p) => p.id);
    menu.reorderProducts([ids[2]!, ids[1]!, ids[0]!]);
    assert.deepEqual(ordenActual(), ['A caballo', 'Napolitana', 'Simple']);
  });

  it('con un id que no existe no rompe ni desordena al resto', () => {
    // Pasa de verdad: alguien acomoda la carta en una pestaña mientras en
    // otra se borró un producto. Lo que no puede pasar es que el acomodo
    // entero se pierda por eso.
    const ids = menu.listProducts({ categoryId: categoria }).map((p) => p.id);
    menu.reorderProducts([ids[0]!, 'un-id-que-no-existe', ids[1]!, ids[2]!]);

    const quedaron = ordenActual();
    assert.equal(quedaron.length, 3, 'no tenía que borrar nada');
    assert.equal(quedaron[0], 'A caballo');
  });
});

describe('los modificadores de un producto', () => {
  const grupo = (nombre: string, id: string) => {
    run('INSERT INTO modifier_groups (id, name, min_select, max_select, position) VALUES (?,?,?,?,?)', [
      id, nombre, 0, 3, 0,
    ]);
    return id;
  };

  it('engancha un grupo y el producto lo devuelve', () => {
    const producto = crear('Napolitana con papas');
    const sinCebolla = grupo('Sacar ingredientes', 'g-sacar');

    menu.attachModifierGroup(producto, sinCebolla);
    const grupos = menu.getModifiersForProduct(producto);

    assert.equal(grupos.length, 1);
    assert.equal(grupos[0]!.name, 'Sacar ingredientes');
  });

  it('engancharlo dos veces no lo duplica', () => {
    // El panel deja apretar dos veces, y un grupo duplicado le llega al bot
    // como dos listas iguales de opciones.
    const producto = crear('Suprema');
    const g = grupo('Agregados', 'g-agregados');

    menu.attachModifierGroup(producto, g);
    menu.attachModifierGroup(producto, g);

    assert.equal(menu.getModifiersForProduct(producto).length, 1);
  });

  it('un grupo sirve para varios productos a la vez', () => {
    const uno = crear('Milanesa de pollo');
    const otro = crear('Milanesa de carne');
    const g = grupo('Punto de cocción', 'g-coccion');

    menu.attachModifierGroup(uno, g);
    menu.attachModifierGroup(otro, g);

    assert.equal(menu.getModifiersForProduct(uno).length, 1);
    assert.equal(menu.getModifiersForProduct(otro).length, 1);
  });

  it('un producto sin grupos devuelve vacío, no rompe', () => {
    assert.deepEqual(menu.getModifiersForProduct(crear('Papas fritas')), []);
  });
});
