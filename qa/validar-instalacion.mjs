/**
 * ¿Está esta instalación lista para atender?
 *
 * Se apunta a cualquier comeIA —la de una notebook, la de un servidor, la de
 * un cliente— y contesta esa pregunta. No prueba el producto: eso lo hacen las
 * suites de qa/suites. Prueba ESTA instalación.
 *
 * Existe porque dar de alta un local son quince cosas y trece se olvidan sin
 * que nada avise. El caso que más duele: un producto sin receta cargada se
 * vende igual y no descuenta nada, así que el stock miente y la alerta de
 * reposición nunca salta. Eso no lo dice ningún error; se descubre el sábado a
 * la noche cuando falta la mozzarella.
 *
 * Cada control tiene un peso:
 *
 *   IMPIDE    no se puede abrir el local así
 *   ANTES     abre, pero hay que arreglarlo antes de atender clientes de verdad
 *   CONVIENE  anda igual, pero después se extraña
 *
 * Uso:
 *   node qa/validar-instalacion.mjs https://pedidos.milocal.com.ar dueño clave
 *   ADMIN_TOKEN=xxx node qa/validar-instalacion.mjs http://127.0.0.1:3000
 *
 * Sale con código 1 si hay algo en IMPIDE, para poder usarlo en un despliegue.
 *
 * Un efecto secundario para tener en cuenta: para comprobar que el límite de
 * intentos esté prendido hay que agotarlo, así que esto hace siete intentos de
 * ingreso fallidos con un usuario que no existe. Eso gasta el cupo de ESA IP
 * por un minuto. Si lo corrés desde la red del local en hora pico, la gente
 * del mostrador puede comerse un "demasiados intentos" mientras tanto.
 */

import { existsSync, readdirSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://127.0.0.1:3000').trim().replace(/\/+$/, '');
const usuario = process.argv[3];
const clave = process.argv[4];
const tokenMaestro = process.env.ADMIN_TOKEN ?? '';

const IMPIDE = 'IMPIDE';
const ANTES = 'ANTES';
const CONVIENE = 'CONVIENE';

const hallazgos = [];
let bien = 0;

/** Un control que pasó o no. `arreglo` es qué hacer, en castellano. */
const control = (grupo, nombre, cumple, peso, detalle = '', arreglo = '') => {
  if (cumple) {
    bien += 1;
    console.log(`  ✓ ${nombre}`);
  } else {
    hallazgos.push({ grupo, nombre, peso, detalle, arreglo });
    const marca = peso === IMPIDE ? '✗' : peso === ANTES ? '!' : '·';
    console.log(`  ${marca} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
};

const grupo = (titulo) => console.log(`\n${titulo}`);

// ── Cómo se entra ───────────────────────────────────────────────────────────
let cookie = '';
const cabeceras = () => ({
  ...(cookie ? { cookie } : {}),
  ...(tokenMaestro && !cookie ? { authorization: `Bearer ${tokenMaestro}` } : {}),
});

const pedir = async (ruta, opciones = {}) => {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), 15000);
  try {
    return await fetch(base + ruta, {
      ...opciones,
      headers: { ...cabeceras(), ...(opciones.headers ?? {}) },
      signal: corte.signal,
    });
  } finally {
    clearTimeout(reloj);
  }
};

const json = async (ruta) => {
  const r = await pedir(ruta);
  if (!r.ok) return { error: r.status };
  return r.json().catch(() => ({ error: 'no es json' }));
};

console.log(`\nRevisando ${base}\n${'─'.repeat(60)}`);

// ── 1. Llega ────────────────────────────────────────────────────────────────
grupo('Llega');

let salud = null;
try {
  const r = await pedir('/api/health');
  salud = r.ok ? await r.json() : null;
  control('llega', 'El servidor contesta', Boolean(salud), IMPIDE, `dio ${r.status}`);
} catch (err) {
  control(
    'llega',
    'El servidor contesta',
    false,
    IMPIDE,
    err.name === 'AbortError' ? 'no contestó en 15 segundos' : err.message,
    'Sin esto no hay nada más que revisar: fijate que esté levantado.',
  );
}

if (!salud) {
  console.log('\nNo llego al servidor, así que no puedo revisar el resto.\n');
  process.exit(1);
}

const esLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/.test(base);
control(
  'llega',
  'Entra por HTTPS',
  base.startsWith('https://') || esLocal,
  esLocal ? CONVIENE : IMPIDE,
  esLocal ? 'estás mirando la de esta máquina' : 'es http, sin la s',
  'Sin HTTPS, Meta no acepta el webhook y las claves de los empleados viajan en claro.',
);

control(
  'llega',
  'El bot usa un modelo de verdad',
  salud.engine === 'llm',
  CONVIENE,
  `está en modo ${salud.engine}`,
  'Sin ANTHROPIC_API_KEY el bot entiende con reglas: alcanza para pedidos simples ' +
    'y se pierde con "sacale la cebolla a dos de las cuatro".',
);

// ── 2. Entrar ───────────────────────────────────────────────────────────────
grupo('Entrar al panel');

if (usuario && clave) {
  const r = await pedir('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usuario, clave }),
  });
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  control('entrar', `Entra con el usuario "${usuario}"`, r.ok && Boolean(cookie), IMPIDE, `dio ${r.status}`);
} else if (tokenMaestro) {
  const r = await pedir('/api/usuarios');
  control(
    'entrar',
    'El token maestro sirve',
    r.ok,
    IMPIDE,
    `dio ${r.status}`,
    'Pasá el ADMIN_TOKEN del servidor, o usuario y clave de un dueño.',
  );
} else {
  console.log('  · Sin credenciales: reviso solo lo que se ve desde afuera.');
  console.log('    Para el resto: node qa/validar-instalacion.mjs ' + base + ' usuario clave');
}

// ── 3. Que nadie se quede con el local ──────────────────────────────────────
grupo('Que nadie se quede con el local');

// Lo más grave de todo: el panel abierto sin sesión.
const sinSesion = await fetch(base + '/api/usuarios').catch(() => null);
control(
  'seguridad',
  'El panel pide sesión',
  !sinSesion || sinSesion.status === 401 || sinSesion.status === 403,
  IMPIDE,
  sinSesion ? `contesta ${sinSesion.status} sin credenciales` : '',
  'Sin ADMIN_TOKEN el panel queda abierto: el primero que encuentre la dirección ' +
    'se lleva la carta, los pedidos y los teléfonos de los clientes.',
);

const cabecerasSalud = (await pedir('/api/health')).headers;
control(
  'seguridad',
  'Las cabeceras de seguridad están puestas',
  cabecerasSalud.get('x-content-type-options') === 'nosniff' &&
    Boolean(cabecerasSalud.get('x-frame-options')),
  ANTES,
  `nosniff: ${cabecerasSalud.get('x-content-type-options') ?? 'no está'}`,
  'Si no están, hay un proxy adelante que las está sacando.',
);

// El límite de intentos: que no se pueda probar el diccionario entero.
const intentos = [];
for (let i = 0; i < 7; i += 1) {
  const r = await pedir('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usuario: 'nadie-que-exista', clave: 'probando' + i }),
  });
  intentos.push(r.status);
}
control(
  'seguridad',
  'Corta los intentos de adivinar la clave',
  intentos.includes(429),
  ANTES,
  `siete intentos seguidos dieron ${[...new Set(intentos)].join(', ')}`,
  'Revisá LOGIN_RATE_MAX. Si está en cero o vacío, el límite queda apagado.',
);

if (cookie || tokenMaestro) {
  const usuarios = await json('/api/usuarios');
  if (!usuarios.error) {
    control(
      'seguridad',
      'Hay un dueño dado de alta',
      (usuarios.duenios_activos ?? 0) >= 1,
      IMPIDE,
      `hay ${usuarios.duenios_activos ?? 0}`,
      'Sin dueño, el primero que abra el panel se queda con el local.',
    );
    // Los tres de abajo solo tienen sentido si ya hay alguien: decirle "te
    // conviene un segundo dueño" a quien tiene cero es ruido que tapa lo que
    // sí importa.
    const hayGente = (usuarios.duenios_activos ?? 0) >= 1;

    if (hayGente) control(
      'seguridad',
      'Hay un segundo dueño',
      (usuarios.duenios_activos ?? 0) >= 2,
      CONVIENE,
      `hay ${usuarios.duenios_activos ?? 0}`,
      'Con uno solo, si se va de vacaciones y se olvida la clave, nadie puede ' +
        'dar de alta a nadie.',
    );

    const gente = usuarios.usuarios ?? [];
    const roles = new Set(gente.filter((u) => u.active).map((u) => u.role));
    if (hayGente) control(
      'seguridad',
      'Cada uno entra con su usuario',
      gente.filter((u) => u.active).length >= 2,
      CONVIENE,
      `hay ${gente.filter((u) => u.active).length} activo(s)`,
      'Si todos usan el del dueño, la bitácora no sirve para nada: ' +
        'todo lo hizo "el dueño".',
    );
    if (hayGente) control(
      'seguridad',
      'La cocina tiene su propio usuario',
      roles.has('cocina') || roles.has('encargado'),
      CONVIENE,
      `roles activos: ${[...roles].join(', ') || 'ninguno'}`,
      'El de cocina solo ve las comandas: no puede tocar precios ni ver la caja.',
    );
  }
}

// ── 4. Puede atender ────────────────────────────────────────────────────────
grupo('Puede atender');

if (cookie || tokenMaestro) {
  const carta = await json('/api/menu?all=1');
  const productos = carta.products ?? [];
  const categorias = carta.categories ?? [];

  control('atender', 'Hay carta cargada', productos.length > 0, IMPIDE, `${productos.length} productos`);
  control('atender', 'Hay categorías', categorias.length > 0, ANTES, `${categorias.length}`);

  const sinPrecio = productos.filter((p) => !p.price_cents || p.price_cents <= 0);
  if (productos.length) control(
    'atender',
    'Todos los productos tienen precio',
    sinPrecio.length === 0,
    IMPIDE,
    sinPrecio.length ? `${sinPrecio.length} sin precio: ${sinPrecio.slice(0, 3).map((p) => p.name).join(', ')}` : '',
    'El bot no puede cobrar algo que vale cero.',
  );

  const activos = productos.filter((p) => p.active);
  if (productos.length) control(
    'atender',
    'Hay productos activos',
    activos.length > 0,
    IMPIDE,
    `${activos.length} de ${productos.length}`,
    'Si están todos inactivos, el bot contesta que no hay nada.',
  );

  const insumos = await json('/api/stock/ingredients');
  const listaInsumos = Array.isArray(insumos) ? insumos : (insumos.items ?? []);
  control('atender', 'Hay insumos cargados', listaInsumos.length > 0, ANTES, `${listaInsumos.length}`);

  // El control que justifica todo este archivo.
  if (activos.length && listaInsumos.length) {
    const aRevisar = activos.slice(0, 60);
    const sinReceta = [];
    for (const p of aRevisar) {
      const receta = await json(`/api/stock/recipes/${p.id}`);
      if (Array.isArray(receta) && receta.length === 0) sinReceta.push(p.name);
    }
    control(
      'atender',
      'Los productos descuentan stock',
      sinReceta.length === 0,
      ANTES,
      sinReceta.length
        ? `${sinReceta.length} sin receta: ${sinReceta.slice(0, 4).join(', ')}${sinReceta.length > 4 ? '…' : ''}`
        : `${aRevisar.length} revisados`,
      'Un producto sin receta se vende y NO descuenta nada: el stock miente y la ' +
        'alerta de reposición nunca salta. Es el error más silencioso del sistema.',
    );

    const sinMinimo = listaInsumos.filter((i) => !i.min_qty || i.min_qty <= 0);
    control(
      'atender',
      'Los insumos tienen mínimo',
      sinMinimo.length === 0,
      CONVIENE,
      sinMinimo.length ? `${sinMinimo.length} sin mínimo` : '',
      'Sin mínimo, ese insumo nunca aparece en "se está por acabar".',
    );
  }

  const proveedores = await json('/api/procurement/suppliers');
  const listaProv = Array.isArray(proveedores) ? proveedores : (proveedores.items ?? []);
  control(
    'atender',
    'Hay proveedores',
    listaProv.length > 0,
    CONVIENE,
    `${listaProv.length}`,
    'Sin proveedores, el botón de reponer no tiene a quién pedirle.',
  );
}

// ── 5. Los canales ──────────────────────────────────────────────────────────
grupo('Los canales');

if (cookie || tokenMaestro) {
  const wa = await json('/api/canales/whatsapp');
  if (!wa.error) {
    control(
      'canales',
      'WhatsApp está conectado',
      wa.activo === true,
      CONVIENE,
      wa.activo ? '' : `falta ${(wa.falta ?? []).join(', ')}`,
      'El local puede atender sin WhatsApp —mostrador y chat web andan igual—, ' +
        'pero es el canal que de verdad usa la gente.',
    );

    if (wa.activo) {
      const prueba = await pedir('/api/canales/whatsapp/probar', { method: 'POST' });
      const diag = prueba.ok ? await prueba.json() : { pasos: [] };
      const fallados = (diag.pasos ?? []).filter((p) => !p.ok);
      control(
        'canales',
        'Meta acepta las credenciales',
        diag.listo === true,
        ANTES,
        fallados.map((p) => p.paso).join('; '),
        fallados.map((p) => p.arreglo).filter(Boolean).join(' '),
      );
    }

    const avisos = await json('/api/canales/avisos');
    if (!avisos.error) {
      control(
        'canales',
        'Le avisa al cliente cuando el pedido está listo',
        avisos.activo === true,
        CONVIENE,
        avisos.activo ? `promete ${avisos.demoraMin} min` : 'están apagados',
        'Sin esto el cliente llama al local para preguntar, que es el teléfono ' +
          'que el bot venía a sacarse de encima.',
      );
    }
  }

  const comandera = await json('/api/orders/comandera/config');
  if (!comandera.error) {
    control(
      'canales',
      'La comandera está configurada',
      Boolean(comandera.host),
      CONVIENE,
      comandera.host ? `${comandera.host}:${comandera.puerto}` : 'sin dirección',
      'Sin comandera, la cocina mira la pantalla. Anda igual.',
    );
  }

  const cobros = await json('/api/cobros/estado');
  if (!cobros.error) {
    control(
      'canales',
      'Cobrar a mano funciona',
      (cobros.medios ?? []).length > 0,
      IMPIDE,
      `${(cobros.medios ?? []).length} medios`,
    );
  }
}

// ── 6. Que no se pierdan los datos ──────────────────────────────────────────
grupo('Que no se pierdan los datos');

if (cookie || tokenMaestro) {
  const retencion = await json('/api/retencion');
  if (!retencion.error) {
    control(
      'datos',
      'Las conversaciones se borran solas',
      (retencion.dias ?? 0) > 0,
      ANTES,
      retencion.dias === 0 ? 'están en "no borrar nunca"' : `a los ${retencion.dias} días`,
      'Los mensajes traen nombres, teléfonos y direcciones. Guardarlos para ' +
        'siempre es terminar con una base de datos de clientes que nadie decidió tener.',
    );
  }

  const locales = await json('/api/locales');
  if (!locales.error && (locales.locales ?? []).length > 1) {
    const sinNumero = locales.locales.filter((l) => l.activo && !l.whatsapp_id);
    control(
      'datos',
      'Cada local tiene su número de WhatsApp',
      sinNumero.length === 0,
      ANTES,
      sinNumero.length ? `${sinNumero.map((l) => l.nombre).join(', ')} sin número` : '',
      'Meta manda todo a la misma dirección: sin esto, los pedidos de un local ' +
        'caen en la cocina del otro.',
    );
  }
}

// El respaldo no se ve por HTTP: solo si se corre en el mismo servidor.
if (esLocal) {
  control(
    'datos',
    'El script de respaldo está',
    existsSync('deploy/backup.sh'),
    ANTES,
    '',
    'Sin respaldo, un disco que se rompe se lleva la facturación del año.',
  );
  control(
    'datos',
    'Hay al menos una copia hecha',
    existsSync('backups') && readdirSync('backups').some((f) => f.endsWith('.db')),
    ANTES,
    '',
    'El script existe y nadie lo corrió nunca: correlo una vez a mano y ' +
      'después ponelo en el cron.',
  );
}

// ── Resultado ───────────────────────────────────────────────────────────────
const porPeso = (p) => hallazgos.filter((h) => h.peso === p);
const impiden = porPeso(IMPIDE);
const antes = porPeso(ANTES);
const convienen = porPeso(CONVIENE);

console.log(`\n${'─'.repeat(60)}`);
console.log(`${bien} controles bien.\n`);

const listar = (titulo, lista) => {
  if (!lista.length) return;
  console.log(`${titulo}\n`);
  for (const h of lista) {
    console.log(`  · ${h.nombre}${h.detalle ? ` (${h.detalle})` : ''}`);
    if (h.arreglo) console.log(`    → ${h.arreglo}`);
  }
  console.log('');
};

listar(`IMPIDE ABRIR — ${impiden.length}`, impiden);
listar(`ANTES DE ATENDER CLIENTES — ${antes.length}`, antes);
listar(`CONVIENE — ${convienen.length}`, convienen);

if (impiden.length === 0 && antes.length === 0) {
  console.log('Esta instalación está lista para atender.\n');
} else if (impiden.length === 0) {
  console.log('Abre, pero arreglá lo de "antes de atender" primero.\n');
} else {
  console.log('Así no se puede abrir el local.\n');
}

process.exit(impiden.length ? 1 : 0);
