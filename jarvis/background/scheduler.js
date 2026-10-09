'use strict';
// Planificador de las tareas de fondo con IA que SOBREVIVE a los reinicios (v3.47.2).
//
// Antes cada tarea se programaba con setInterval + un setTimeout de arranque: cada reinicio del add-on (una
// actualizacion, un corte de Proxmox...) volvia a lanzar proactivo, patrones, conocimiento y destilado a los 15-30
// min aunque acabaran de ejecutarse, y el primer intervalo empezaba de cero. El 08-10-2026, con varias
// actualizaciones el mismo dia, el proactivo hizo 85 llamadas de IA (30 de pago). Ahora la ultima ejecucion de cada
// tarea se guarda en /data/bg_last_run.json y una tarea corre como mucho una vez por intervalo, reinicie quien reinicie.
const path = require('path');
const C = require('../utils/constants');
const { loadJSON, saveJSON } = require('../utils/persistence');

const BG_RUNS_FILE = path.join(C.DATA_DIR, 'bg_last_run.json');
const SLACK = 0.9;   // la comprobacion es cada pocos minutos: se admite un 10 % menos que el intervalo

function shouldRun(last, now, intervalMs) {
  return !last || now - last >= intervalMs * SLACK;
}

// Programa `fn` cada `intervalMs`; la primera comprobacion es a los `startDelayMs` del arranque y despues se vuelve a
// mirar cada `checkMs`. Devuelve la funcion de comprobacion (la usan las pruebas).
function scheduleJob(name, fn, intervalMs, startDelayMs, { file = BG_RUNS_FILE, checkMs = 5 * 60_000, now = Date.now } = {}) {
  const check = async () => {
    const runs = loadJSON(file, {});
    if (!shouldRun(runs[name], now(), intervalMs)) return false;
    runs[name] = now();
    saveJSON(file, runs);   // se apunta ANTES de ejecutar: un reinicio a mitad no la repite
    try { await fn(); } catch (e) { console.log(`[bg] ${name} error: ${e.message}`); }
    return true;
  };
  setTimeout(() => {
    check().then(ran => {
      if (!ran) {
        const last = loadJSON(file, {})[name];
        console.log(`[bg] ${name}: arranque saltado (ultima ejecucion hace ${Math.round((now() - last) / 60000)} min, intervalo ${Math.round(intervalMs / 60000)} min)`);
      }
    }).catch(() => {});
  }, startDelayMs);
  setInterval(() => { check().catch(() => {}); }, checkMs);
  return check;
}

module.exports = { scheduleJob, shouldRun, BG_RUNS_FILE };
