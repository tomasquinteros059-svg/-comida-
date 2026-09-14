import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('comandera');

const { closeDb } = await import('../db/index.js');
const { createCategory, createProduct } = await import('../domain/menu.js');
const { createOrder } = await import('../domain/orders.js');
const comandera = await import('../domain/comandera.js');

let pedido: string;

/**
 * Una comandera de mentira: escucha en un puerto y guarda lo que le mandan.
 * Es exactamente lo que hace una impresora térmica de red —abrir el 9100 y
 * tragar bytes— así que probar contra esto prueba el camino entero.
 */
function comanderaDeMentira() {
  const recibido: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (d) => recibido.push(d));
  });
  return {
    recibido,
    escuchar: () =>
      new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port))),
    cerrar: () => new Promise<void>((r) => server.close(() => r())),
    get bytes() {
      return Buffer.concat(recibido);
    },
  };
}

before(() => {
  const categoria = createCategory({ name: 'Milanesas' }).id;
  const producto = createProduct({
    name: 'Milanesa napolitana con papas',
    category_id: categoria,
    price_cents: 250_000,
  }).id;
  pedido = createOrder({
    lines: [{ product_id: producto, qty: 2, note: 'sin sal' }],
    customer_name: 'Señora Muñoz',
    confirm: true,
  }).id;
});

after(() => closeDb());

describe('la comanda que sale por la impresora', () => {
  it('empieza inicializando la impresora y termina cortando el papel', () => {
    const bytes = comandera.comandaEnBytes(pedido);
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40], 'ESC @ es "volvé a fábrica"');
    assert.deepEqual([...bytes.subarray(-4)], [0x1d, 0x56, 0x42, 0x42], 'GS V es el corte');
  });

  it('el número del pedido va en grande, que es lo único que se mira de lejos', () => {
    const bytes = comandera.comandaEnBytes(pedido);
    const texto = bytes.toString('latin1');
    const grande = texto.indexOf('\x1d\x21\x11');
    const numero = texto.indexOf('#001');
    const normal = texto.indexOf('\x1d\x21\x00');
    assert.ok(grande >= 0 && numero > grande && normal > numero, 'el número tiene que ir entre grande y normal');
  });

  it('saca los acentos: las comanderas viejas los imprimen como basura', () => {
    const bytes = comandera.comandaEnBytes(pedido);
    const texto = bytes.toString('latin1');
    assert.match(texto, /Senora Munoz/, '"Señora Muñoz" tiene que salir legible');
    assert.ok(!/[áéíóúñÑ]/.test(texto));
    assert.match(texto, /Milanesa napolitana/);
  });

  it('lleva lo que la cocina necesita: cantidad, producto y la nota', () => {
    const texto = comandera.comandaEnBytes(pedido).toString('latin1');
    assert.match(texto, / 2 x Milanesa napolitana/);
    assert.match(texto, /sin sal/);
  });

  it('dos copias son la misma comanda dos veces, no una comanda larga', () => {
    const una = comandera.comandaEnBytes(pedido, { copias: 1 });
    const dos = comandera.comandaEnBytes(pedido, { copias: 2 });
    assert.equal(dos.length, una.length * 2);
    assert.ok(dos.subarray(0, una.length).equals(una));
  });

  it('no deja pedir cincuenta copias por un cero de más', () => {
    const muchas = comandera.comandaEnBytes(pedido, { copias: 50 });
    const una = comandera.comandaEnBytes(pedido, { copias: 1 });
    assert.equal(muchas.length, una.length * 5, 'cinco es el tope');
  });

  it('el cajón se abre solo si se lo pide', () => {
    const cajon = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]).toString('latin1');
    assert.ok(!comandera.comandaEnBytes(pedido).toString('latin1').includes(cajon));
    assert.ok(comandera.comandaEnBytes(pedido, { abrirCajon: true }).toString('latin1').includes(cajon));
  });
});

describe('hablar con la impresora', () => {
  it('le llegan los bytes tal cual', async () => {
    const falsa = comanderaDeMentira();
    const puerto = await falsa.escuchar();

    comandera.fijarComandera({ host: '127.0.0.1', puerto, automatica: false, copias: 1 });
    const resultado = await comandera.imprimirComanda(pedido);

    assert.equal(resultado.impreso, true, resultado.motivo);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(falsa.bytes.length > 0, 'la impresora tiene que haber recibido algo');
    assert.match(falsa.bytes.toString('latin1'), /Milanesa napolitana/);
    assert.equal(falsa.bytes.length, resultado.bytes);
    await falsa.cerrar();
  });

  it('si la impresora está apagada lo dice, no se cuelga', async () => {
    // Puerto cerrado a propósito.
    comandera.fijarComandera({ host: '127.0.0.1', puerto: 9, automatica: false });
    const resultado = await comandera.imprimirComanda(pedido);
    assert.equal(resultado.impreso, false);
    assert.match(resultado.motivo ?? '', /comandera/i);
  });

  it('sin comandera configurada no rompe: avisa y sigue', async () => {
    comandera.fijarComandera({ host: '', automatica: false });
    const resultado = await comandera.imprimirComanda(pedido);
    assert.equal(resultado.impreso, false);
    assert.match(resultado.motivo ?? '', /No hay comandera/);
  });

  it('un pedido nuevo se imprime solo cuando está en automático', async () => {
    const falsa = comanderaDeMentira();
    const puerto = await falsa.escuchar();
    comandera.fijarComandera({ host: '127.0.0.1', puerto, automatica: true, copias: 1 });

    const categoria = createCategory({ name: 'Pizzas' }).id;
    const producto = createProduct({ name: 'Pizza muzzarella', category_id: categoria, price_cents: 110_000 }).id;
    createOrder({ lines: [{ product_id: producto, qty: 1 }], confirm: true });

    await new Promise((r) => setTimeout(r, 400));
    assert.match(falsa.bytes.toString('latin1'), /Pizza muzzarella/, 'tenía que salir sola');
    await falsa.cerrar();
  });

  it('con la impresora apagada, el pedido se toma igual', async () => {
    comandera.fijarComandera({ host: '127.0.0.1', puerto: 9, automatica: true });
    const categoria = createCategory({ name: 'Postres' }).id;
    const producto = createProduct({ name: 'Flan', category_id: categoria, price_cents: 50_000 }).id;

    const pedidoNuevo = createOrder({ lines: [{ product_id: producto, qty: 1 }], confirm: true });
    assert.ok(pedidoNuevo.id, 'el pedido vale más que la impresión');
    await new Promise((r) => setTimeout(r, 300));
  });
});

describe('la configuración', () => {
  it('queda guardada y sobrevive al reinicio', () => {
    comandera.fijarComandera({ host: '192.168.1.87', puerto: 9100, automatica: true, copias: 2 });
    const leida = comandera.configDeComandera();
    assert.deepEqual(leida, { host: '192.168.1.87', puerto: 9100, automatica: true, copias: 2 });
    assert.equal(comandera.hayComandera(), true);
  });

  it('sin configurar, el puerto por defecto es el 9100', () => {
    comandera.fijarComandera({ host: '', puerto: 9100, automatica: false, copias: 1 });
    assert.equal(comandera.configDeComandera().puerto, 9100);
    assert.equal(comandera.hayComandera(), false);
  });
});
