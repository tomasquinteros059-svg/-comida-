const B='http://127.0.0.1:3000', T='token-de-qa-bien-largo-32b';
const p=(r,b)=>fetch(B+r,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(s=>s.status);
console.log('bootstrap', await p('/api/auth/bootstrap',{name:'Ana',usuario:'ana',clave:'clave-de-prueba',token:T}));
const alta=(n,u,rol)=>fetch(B+'/api/usuarios',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+T},body:JSON.stringify({name:n,usuario:u,clave:'clave-de-prueba',role:rol})}).then(s=>s.status);
console.log('beto', await alta('Beto','beto','encargado'));
console.log('caro', await alta('Caro','caro','cocina'));
