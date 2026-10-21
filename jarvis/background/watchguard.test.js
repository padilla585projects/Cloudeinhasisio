// Pruebas de watchguard sin tocar HA. node jarvis/background/watchguard.test.js
const { revisarCaidos, revisarLog, firmaDeLog, esVigilable } = require('./watchguard');

const MIN = 60_000, H = 3600_000, T0 = Date.UTC(2026, 9, 1, 12, 0);
let fallos = 0;
const ok = (c, t) => { console.log((c ? '  OK   ' : '  MAL  ') + t); if (!c) fallos++; };
const ent = (id, state, name) => ({ entity_id: id, state, attributes: { friendly_name: name } });

(async () => {
  // --- esVigilable ---
  ok(esVigilable(ent('switch.neptune', 'on')) === true, 'esVigilable: un switch sí');
  ok(esVigilable(ent('automation.luz', 'on')) === false, 'esVigilable: una automatización no');
  ok(esVigilable(ent('button.x', 'unknown')) === false, 'esVigilable: un botón no (unknown por diseño)');

  // --- dispositivos caídos ---
  // 1. Caído pero solo 10 min -> aún no avisa
  { const st = {}; const av = [];
    await revisarCaidos(st, [ent('switch.a', 'unavailable', 'Enchufe A')], T0, m => av.push(m));
    // segunda pasada 10 min después, sigue caído
    const r = await revisarCaidos(st, [ent('switch.a', 'unavailable', 'Enchufe A')], T0 + 10*MIN, m => av.push(m));
    ok(av.length === 0 && st.down['switch.a'] && !st.down['switch.a'].avisado, '1. caído 10 min -> no avisa todavía'); }

  // 2. Caído 35 min -> avisa una vez
  { const st = { down: { 'switch.a': { since: T0, avisado: false, reavisado: 0, nombre: 'Enchufe A' } } };
    const av = [];
    await revisarCaidos(st, [ent('switch.a', 'unavailable', 'Enchufe A')], T0 + 35*MIN, m => av.push(m));
    ok(av.length === 1 && /Enchufe A/.test(av[0]) && /30 min/.test(av[0]), '2. caído 35 min -> avisa una vez');
    // segunda pasada: no repite
    const av2 = [];
    await revisarCaidos(st, [ent('switch.a', 'unavailable', 'Enchufe A')], T0 + 40*MIN, m => av2.push(m));
    ok(av2.length === 0, '2b. no repite el aviso en la siguiente vuelta'); }

  // 3. Varios caídos a la vez -> UN solo aviso agrupado
  { const st = {}; const base = T0 - 40*MIN;
    st.down = {
      'switch.a': { since: base, avisado: false, reavisado: 0, nombre: 'A' },
      'switch.b': { since: base, avisado: false, reavisado: 0, nombre: 'B' },
      'switch.c': { since: base, avisado: false, reavisado: 0, nombre: 'C' },
    };
    const av = [];
    await revisarCaidos(st, [ent('switch.a','unavailable','A'), ent('switch.b','unavailable','B'), ent('switch.c','unavailable','C')], T0, m => av.push(m));
    ok(av.length === 1 && /3 dispositivos/.test(av[0]), '3. tres caídos a la vez -> un aviso agrupado'); }

  // 4. Recuperación -> avisa de vuelta con la duración
  { const st = { down: { 'switch.a': { since: T0 - 2*H, avisado: true, reavisado: T0 - 2*H, nombre: 'Enchufe A' } } };
    const av = [];
    await revisarCaidos(st, [ent('switch.a', 'on', 'Enchufe A')], T0, m => av.push(m));
    ok(av.length === 1 && /ha vuelto/.test(av[0]) && !st.down['switch.a'], '4. recuperado -> avisa y limpia el estado'); }

  // 5. Recuperación de algo que NUNCA llegó a avisarse -> silencio
  { const st = { down: { 'switch.a': { since: T0 - 10*MIN, avisado: false, reavisado: 0, nombre: 'A' } } };
    const av = [];
    await revisarCaidos(st, [ent('switch.a', 'on', 'A')], T0, m => av.push(m));
    ok(av.length === 0 && !st.down['switch.a'], '5. parpadeo (<30 min) -> ni aviso de caída ni de vuelta'); }

  // 6. Sigue caído tras 24 h -> un recordatorio
  { const st = { down: { 'switch.a': { since: T0 - 25*H, avisado: true, reavisado: T0 - 25*H, nombre: 'A' } } };
    const av = [];
    await revisarCaidos(st, [ent('switch.a', 'unavailable', 'A')], T0, m => av.push(m));
    ok(av.length === 1 && /sigue caído/.test(av[0]), '6. 25 h caído -> un recordatorio diario'); }

  // 6b. 30 dispositivos cruzan a la vez las 24 h (restauracion de HA) -> UN solo mensaje, no 30
  { const st = { down: {} }; const estados = [];
    for (let i = 0; i < 30; i++) {
      st.down['switch.d' + i] = { since: T0 - (480 + i) * H, avisado: true, reavisado: T0 - 25 * H, nombre: 'Disp ' + i };
      estados.push(ent('switch.d' + i, 'unavailable', 'Disp ' + i));
    }
    const av = [];
    const n = await revisarCaidos(st, estados, T0, m => av.push(m));
    ok(av.length === 1 && n === 1 && /30 dispositivos siguen caídos/.test(av[0]), '6b. 30 recordatorios a la vez -> un solo mensaje');
    ok(/…y 22 más/.test(av[0]) && av[0].split('\n').length === 10, '6c. lista de 8 + "…y 22 más"');
    ok(av[0].indexOf('Disp 29') < av[0].indexOf('Disp 22') && !/Disp 21\b/.test(av[0]), '6d. ordenados por antigüedad (los más viejos primero)');
    const av2 = [];
    await revisarCaidos(st, estados, T0 + 2 * H, m => av2.push(m));
    ok(av2.length === 0, '6e. no repite en la vuelta siguiente'); }

  // 6f. un dispositivo + otros nuevos + otros recuperados a la vez -> como mucho 3 mensajes
  { const st = { down: {
      'switch.v1': { since: T0 - 30 * H, avisado: true, reavisado: T0 - 25 * H, nombre: 'Viejo 1' },
      'switch.v2': { since: T0 - 31 * H, avisado: true, reavisado: T0 - 25 * H, nombre: 'Viejo 2' },
      'switch.r1': { since: T0 - 3 * H, avisado: true, reavisado: T0 - 3 * H, nombre: 'Vuelve 1' },
      'switch.r2': { since: T0 - 3 * H, avisado: true, reavisado: T0 - 3 * H, nombre: 'Vuelve 2' },
      'switch.n1': { since: T0 - 40 * MIN, avisado: false, reavisado: 0, nombre: 'Nuevo 1' },
      'switch.n2': { since: T0 - 40 * MIN, avisado: false, reavisado: 0, nombre: 'Nuevo 2' } } };
    const av = [];
    await revisarCaidos(st, [ent('switch.v1','unavailable','Viejo 1'), ent('switch.v2','unavailable','Viejo 2'), ent('switch.r1','on','Vuelve 1'), ent('switch.r2','on','Vuelve 2'), ent('switch.n1','unavailable','Nuevo 1'), ent('switch.n2','unavailable','Nuevo 2')], T0, m => av.push(m));
    ok(av.length === 3, '6f. nuevos + recordatorios + recuperados a la vez -> 3 mensajes (uno por tipo)');
    ok(av.some(m => /2 dispositivos han vuelto/.test(m) && /Vuelve 1 \(caído 3 h\)/.test(m)), '6g. las recuperaciones van agrupadas, con la duración de cada una'); }

  // --- log repetido ---
  // 7. Un error que se repite 12 veces -> avisa
  { const st = {}; const av = [];
    const linea = '2026-10-01 12:00:SS.123 ERROR (MainThread) [homeassistant.components.foo] Timeout connecting to 192.168.1.5';
    const log = Array.from({length: 12}, (_, i) => linea.replace('SS', String(i).padStart(2, '0'))).join('\n');
    await revisarLog(st, log, T0, m => av.push(m));
    ok(av.length === 1 && /se repite/.test(av[0]) && /12 veces/.test(av[0]), '7. error ×12 -> avisa');
    // segunda vez el mismo día: no repite
    const av2 = [];
    await revisarLog(st, log, T0 + 2*H, m => av2.push(m));
    ok(av2.length === 0, '7b. no repite el mismo error el mismo día'); }

  // 8. Un error que sale 3 veces -> NO avisa (es ruido)
  { const st = {}; const av = [];
    const log = Array.from({length: 3}, () => '2026-10-01 12:00:00 ERROR (X) algo puntual pasó aquí').join('\n');
    await revisarLog(st, log, T0, m => av.push(m));
    ok(av.length === 0, '8. error ×3 -> no avisa (ruido)'); }

  // 9. firmaDeLog agrupa pese a timestamps/handles/números distintos
  { const a = firmaDeLog('2026-10-01 12:00:00.1 ERROR z2m: cmd 0xa4c1 to Escalera failed timeout after 10000ms tsn=60');
    const b = firmaDeLog('2026-10-01 20:33:17.9 ERROR z2m: cmd 0xbbbb to Escalera failed timeout after 10000ms tsn=214');
    ok(a === b && a.length > 20, '9. misma firma pese a timestamp/handle/tsn distintos'); }

  console.log(fallos ? `\n${fallos} FALLO(S)` : '\nTODO CORRECTO');
  process.exit(fallos ? 1 : 0);
})();
