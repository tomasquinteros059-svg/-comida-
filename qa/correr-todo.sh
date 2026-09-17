#!/usr/bin/env bash
#
# Corre cada suite del QA sobre una pila recién levantada.
#
# Sin esto las suites se ensucian entre sí: una le cambia la clave a un usuario
# que la siguiente usa, otra da de baja a un dueño, otra agota el límite de
# intentos a propósito, otra deja cargada la dirección de una comandera. Eso no
# dice nada del producto, solo del orden en que se corrieron.
#
# Uso:
#   ./qa/correr-todo.sh
#
# Necesita docker y las dependencias del navegador (playwright) instaladas.
set -u
cd "$(dirname "$0")/.."
QA="$(pwd)/qa/suites"
export ADMIN_TOKEN="${ADMIN_TOKEN:-token-de-qa-bien-largo-32b}"

pila_limpia() {
  docker compose down -v > /dev/null 2>&1
  docker compose up -d > /dev/null 2>&1
  sleep 10
  docker compose exec -T comeia node server/dist/db/seed.js > /dev/null 2>&1
}

# Usuarios + movimientos de varias personas, que es lo que necesitan los
# filtros de la bitácora para tener de dónde elegir.
poblar() {
  node "$QA/sembrar.mjs" > /dev/null 2>&1
  node -e "
    const T=process.env.ADMIN_TOKEN, B='http://127.0.0.1:3000';
    (async () => {
      await fetch(B+'/api/usuarios',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+T},body:JSON.stringify({name:'Dani',usuario:'dani',clave:'clave-de-prueba',role:'dueño'})});
      for (const [u,n] of [['ana','Ana'],['beto','Beto']]) {
        const r = await fetch(B+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({usuario:u,clave:'clave-de-prueba'})});
        const ck = (r.headers.get('set-cookie')||'').split(';')[0];
        for (let i=0;i<3;i++) await fetch(B+'/api/menu/categories',{method:'POST',headers:{'content-type':'application/json',cookie:ck},body:JSON.stringify({name:n+' cat '+i})});
      }
    })();
  " > /dev/null 2>&1
  sleep 1
}

titulo() { echo; echo "════ $* ════"; }

titulo "1. ACCESO Y PERMISOS"
pila_limpia
node "$QA/1-acceso.mjs" 2>&1 | grep -aE "^FALLA|^==="

titulo "2. FLUJO OPERATIVO DE PUNTA A PUNTA"
pila_limpia
node "$QA/2-flujo.mjs" > /tmp/qa2.txt 2>&1
echo "=== $(grep -acE '^OK' /tmp/qa2.txt)/$(( $(grep -acE '^OK' /tmp/qa2.txt) + $(grep -acE '^FALLA' /tmp/qa2.txt) )) casos OK ==="
grep -aE "^FALLA" /tmp/qa2.txt || true

titulo "3. CLAVE PROPIA Y MENSAJES EN CASTELLANO"
pila_limpia
node "$QA/sembrar.mjs" > /dev/null 2>&1
node "$QA/3-clave.mjs" 2>&1 | grep -aE "^FALLA|^==="

titulo "4. PAGINACIÓN, BITÁCORA, RETENCIÓN Y SEGUNDO DUEÑO"
pila_limpia
node "$QA/sembrar.mjs" > /dev/null 2>&1
node "$QA/4-bitacora.mjs" 2>&1 | grep -aE "^FALLA|^==="

titulo "5. COMANDERA, EXCEL/PDF, WHATSAPP, COBROS Y VARIOS LOCALES"
pila_limpia
EXCEL_B64="$(cat "$QA/carta.b64")" HOST_DESDE_CONTENEDOR=172.18.0.1 node "$QA/5-canales.mjs" 2>&1 | grep -aE "^FALLA|^==="

titulo "6. LO MISMO, EN EL NAVEGADOR"
pila_limpia
poblar
QA="$QA" node "$QA/6-navegador.mjs" 2>&1 | grep -aE "^FALLA|^===|^problemas"

titulo "7. CAMBIO DE CLAVE EN EL NAVEGADOR (teléfono)"
pila_limpia
node "$QA/sembrar.mjs" > /dev/null 2>&1
QA="$QA" node "$QA/7-clave-telefono.mjs" 2>&1 | grep -avE "agent-proxy|^- |^For details"

titulo "8. PANEL EN ESCRITORIO Y TELÉFONO"
pila_limpia
node "$QA/sembrar.mjs" > /dev/null 2>&1
QA="$QA" node "$QA/8-panel.mjs" 2>&1 | grep -avE "agent-proxy|^- |^For details" | tail -6
