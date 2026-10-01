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
