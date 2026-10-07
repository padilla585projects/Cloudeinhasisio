'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// SPENDWATCH — avisos del gasto de IA de pago de Jarvis en el pool.
//
// POR QUE EXISTE: con "todo por el pool, sin respaldos" (v3.44.0) el gasto de pago lo lleva el Core del
// pool (100 EUR/mes en total entre todas las apps) y puede fijar un tope DURO por proyecto: al llegar,
// TODA llamada de pago de Jarvis recibe 429 `project_budget_exceeded` (interactiva incluida) y Jarvis se
// queda sin IA de pago hasta el mes siguiente. Adrian fijo 15 EUR/mes para Jarvis (07-10-2026). Esto avisa
// ANTES de llegar, por el canal comun de los vigilantes (utils/notify.js).
//
// Cada 2 h lee GET /v1/spend/me del pool (con la clave de Jarvis) y avisa UNA vez al mes al 70 %, 90 % y
// 100 % del tope. Tope = el del pool (project_cap_eur) si existe; si el Core aun no lo ha puesto, la cifra
// acordada (POOL_SPEND_ALERT_EUR, 15 por defecto). Tambien avisa una vez por estado cuando el gasto GLOBAL
// del pool pasa a warn / critical / over.
//
// IMPACTO DE TOKENS: CERO. Ninguna llamada a un LLM: un GET de unos cientos de bytes cada 2 h (12/dia).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const C = require('../utils/constants');
const state = require('../utils/state');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { poolSpendMe } = require('../utils/llm');
const { notify } = require('../utils/notify');

const FILE = path.join(C.DATA_DIR, 'spend_alerts.json');
const UMBRALES = [70, 90, 100];
const ESTADOS_GLOBALES = ['warn', 'critical', 'over'];

function mesActual(now = new Date()) { return now.toISOString().slice(0, 7); }

// Funcion pura (sin red ni disco): decide que avisos toca mandar y como queda el registro de avisos.
function evaluarGasto(me, guardado, now = new Date(), capAviso = C.POOL_SPEND_ALERT_EUR) {
  const mes = mesActual(now);
  const previo = (guardado && guardado.month === mes) ? guardado : { month: mes, umbrales: [], global: [] };
  const nuevo = { month: mes, umbrales: [...(previo.umbrales || [])], global: [...(previo.global || [])] };
  const mensajes = [];

  const gasto = Number(me.project_month_eur) || 0;
  const capPool = Number(me.project_cap_eur) > 0 ? Number(me.project_cap_eur) : 0;
  const cap = capPool || capAviso;
  const pct = cap > 0 ? (gasto / cap) * 100 : 0;

  // Si se cruzan varios umbrales de golpe (p. ej. 0 -> 95 %), un solo aviso, el del mas alto.
  const cruzados = UMBRALES.filter(u => pct >= u && !nuevo.umbrales.includes(u));
  if (cruzados.length) {
    const u = Math.max(...cruzados);
    nuevo.umbrales.push(...cruzados);
    const origen = capPool ? 'tope del pool' : 'tope acordado';
    let txt = `💶 Jarvis lleva ${gasto.toFixed(2)} € de ${cap.toFixed(0)} € este mes en la IA de pago (${Math.round(pct)} % del ${origen}).`;
    if (u >= 100) {
      txt += capPool
        ? ' TOPE ALCANZADO: el pool corta toda llamada de pago de Jarvis hasta el mes siguiente o hasta que se suba el tope; solo funciona la IA local.'
        : ' Has superado la cifra acordada (el pool todavia no tiene un tope duro puesto).';
    } else if (u >= 90) {
      txt += ' Queda poco margen.';
    }
    mensajes.push({ nivel: u, texto: txt });
  }

  const est = String(me.state || '');
  if (ESTADOS_GLOBALES.includes(est) && !nuevo.global.includes(est)) {
    nuevo.global.push(est);
    mensajes.push({
      nivel: 'global',
      texto: `💶 El gasto TOTAL de IA de pago del pool (todas las apps) esta en estado "${est}": ` +
             `${(Number(me.month_eur) || 0).toFixed(2)} € de ${Number(me.budget_eur) || 100} € este mes.` +
             (est === 'over' ? ' Lo aplazable (trabajo de fondo) queda bloqueado.' : '')
    });
  }
  return { mensajes, nuevo, pct, cap, gasto };
}

// deps solo para pruebas: { force, poolSpendMe, notify, load, save, now }
async function spendWatchLoop(deps = {}) {
  try {
    if (!C.USE_POOL && !deps.force) return;
    const me = await (deps.poolSpendMe || poolSpendMe)();
    if (!me) return;   // poolSpendMe ya registra el motivo

    const r0 = evaluarGasto(me, null, deps.now);
    state.poolSpend = {
      project_month_eur: r0.gasto, cap_eur: r0.cap, pct: Math.round(r0.pct),
      cap_del_pool: Number(me.project_cap_eur) > 0, state: me.state || null,
      month_eur: Number(me.month_eur) || 0, budget_eur: Number(me.budget_eur) || null,
      checkedAt: new Date().toISOString()
    };

    const guardado = (deps.load || loadJSON)(FILE, null);
    const r = evaluarGasto(me, guardado, deps.now);
    console.log(`[spend] jarvis: ${r.gasto.toFixed(2)} € de ${r.cap.toFixed(0)} € (${Math.round(r.pct)} %) · global: ${me.state || '?'}`);

    let entregados = true;
    for (const m of r.mensajes) {
      const canal = await (deps.notify || notify)(m.texto, { title: 'Jarvis — gasto de IA', source: 'spendwatch' });
      console.log(`[spend] aviso ${m.nivel} -> ${canal}`);
      if (canal === 'ninguno') entregados = false;
    }
    // Si algun aviso no salio por ningun canal NO se marca como enviado: se reintenta en 2 h.
    if (r.mensajes.length && entregados) (deps.save || saveJSON)(FILE, r.nuevo);
  } catch (e) {
    console.log(`[spend] error: ${e.message}`);
  }
}

module.exports = { spendWatchLoop, evaluarGasto };
