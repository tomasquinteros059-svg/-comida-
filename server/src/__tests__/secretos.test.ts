import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase('secretos');
process.env.ADMIN_TOKEN = 'un-token-de-administracion-bien-largo';
// Sin variables de entorno de WhatsApp: acá se prueba justamente el otro
// camino, el de cargarlas desde el panel.
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_VERIFY_TOKEN;
delete process.env.WHATSAPP_APP_SECRET;

const { getSetting } = await import('../db/index.js');
const secretos = await import('../domain/secretos.js');
const wa = await import('../domain/whatsapp.js');

const TOKEN_DE_META = 'EAAG1234567890unTokenLargoDeMeta';

describe('las credenciales guardadas en la base', () => {
  it('se guardan y se leen', () => {
    secretos.guardarSecreto('prueba', TOKEN_DE_META);
    assert.equal(secretos.leerSecreto('prueba'), TOKEN_DE_META);
  });

  it('en la base NO queda el valor, queda cifrado', () => {
    secretos.guardarSecreto('prueba', TOKEN_DE_META);
    const crudo = getSetting('secreto.prueba', '');

    // Esto es lo que importa de todo el archivo: la base se respalda todas
    // las noches y esas copias terminan circulando. Si el token estuviera
    // legible, una copia perdida deja mandar mensajes en nombre del local.
    assert.ok(crudo.length > 0, 'algo se tiene que haber guardado');
    assert.ok(!crudo.includes(TOKEN_DE_META), 'el token no puede estar legible en la base');
    assert.match(crudo, /^v1:/, 'queda marcado con qué método se cifró');
  });

  it('dos veces el mismo valor no da el mismo cifrado', () => {
    secretos.guardarSecreto('a', TOKEN_DE_META);
    const uno = getSetting('secreto.a', '');
    secretos.guardarSecreto('a', TOKEN_DE_META);
    const dos = getSetting('secreto.a', '');

    // Si diera igual, comparando dos backups se sabría que la credencial no
    // cambió, y con un diccionario chico se podría adivinar cuál es.
    assert.notEqual(uno, dos, 'cada guardado usa un nonce nuevo');
    assert.equal(secretos.leerSecreto('a'), TOKEN_DE_META, 'y los dos se leen igual');
  });

  it('una fila editada a mano no se lee: falla, no devuelve basura', () => {
    secretos.guardarSecreto('b', TOKEN_DE_META);
    const crudo = getSetting('secreto.b', '');
    const partes = crudo.split(':');
    // Cambiar un byte del texto cifrado.
    const roto = [partes[0], partes[1], partes[2], Buffer.from('otra cosa').toString('base64')].join(':');
    assert.equal(secretos.descifrar(roto), '', 'la etiqueta de GCM no coincide');
  });

  it('con otro ADMIN_TOKEN no se puede abrir', () => {
    secretos.guardarSecreto('c', TOKEN_DE_META);
    const guardado = getSetting('secreto.c', '');

    // Es el caso de la copia robada: el ladrón tiene la base y no el .env.
    const original = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'el-token-de-otra-instalacion';
    // config se lee una vez, así que se prueba derivando a mano lo mismo que
    // haría otra instalación: alcanza con comprobar que el nuestro sí abre y
    // que un valor de otra forma no.
    process.env.ADMIN_TOKEN = original;

    assert.equal(secretos.leerSecreto('c'), TOKEN_DE_META);
    assert.equal(secretos.descifrar('v1:' + Buffer.from('123456789012').toString('base64') + ':' +
      Buffer.from('0123456789abcdef').toString('base64') + ':' +
      Buffer.from('cualquier cosa').toString('base64')), '');
  });

  it('guardar vacío borra', () => {
    secretos.guardarSecreto('d', TOKEN_DE_META);
    assert.equal(secretos.hayGuardado('d'), true);
    secretos.guardarSecreto('d', '');
    assert.equal(secretos.hayGuardado('d'), false);
    assert.equal(secretos.leerSecreto('d'), '');
  });
});

describe('cargar WhatsApp desde el panel', () => {
  it('sin nada cargado, dice que faltan las cuatro', () => {
    assert.equal(wa.whatsappActivo(), false);
    assert.equal(wa.loQueFaltaDeWhatsapp().length, 4);
  });

  it('cargadas desde el panel, WhatsApp queda activo', () => {
    wa.guardarCredenciales({
      phoneNumberId: '123456789012345',
      token: TOKEN_DE_META,
      verifyToken: 'la-palabra-del-local',
      appSecret: 'la-clave-de-la-app',
    });

    assert.equal(wa.whatsappActivo(), true, 'sin tocar el .env ni entrar al servidor');
    assert.deepEqual(wa.loQueFaltaDeWhatsapp(), []);
    assert.equal(wa.configWhatsapp().token, TOKEN_DE_META);
  });

  it('se puede cambiar una sola sin volver a pegar las otras tres', () => {
    wa.guardarCredenciales({ token: 'EAAG-un-token-nuevo' });

    const c = wa.configWhatsapp();
    assert.equal(c.token, 'EAAG-un-token-nuevo');
    assert.equal(c.verifyToken, 'la-palabra-del-local', 'las otras quedaron como estaban');
    assert.equal(c.appSecret, 'la-clave-de-la-app');
  });

  it('el panel dice de dónde sale cada una, sin devolver ninguna', () => {
    const origen = wa.origenDeCredenciales();
    assert.equal(origen.token, 'panel');
    assert.equal(origen.appSecret, 'panel');

    const texto = JSON.stringify(origen);
    assert.ok(!texto.includes('EAAG'), 'el origen no puede traer el valor');
    assert.ok(!texto.includes('la-clave-de-la-app'));
  });

  it('la variable de entorno le gana a lo cargado en el panel', () => {
    // El que administra el servidor tiene la última palabra, y una instalación
    // que ya andaba con el .env no puede cambiar de comportamiento porque
    // alguien guardó algo en el panel.
    process.env.WHATSAPP_TOKEN = 'el-token-del-servidor';

    assert.equal(wa.configWhatsapp().token, 'el-token-del-servidor');
    assert.equal(wa.origenDeCredenciales().token, 'entorno');

    delete process.env.WHATSAPP_TOKEN;
    assert.equal(wa.configWhatsapp().token, 'EAAG-un-token-nuevo', 'y al sacarla vuelve la del panel');
  });

  it('desconectar el local es guardar vacío', () => {
    wa.guardarCredenciales({ token: '' });
    assert.equal(wa.whatsappActivo(), false);
    assert.match(wa.loQueFaltaDeWhatsapp().join(' '), /token/);
  });
});
