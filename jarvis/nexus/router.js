'use strict';
const { callOpenAI } = require('../utils/llm');
const { BG_MODEL } = require('../utils/constants');
const { tools } = require('../tools/definitions');
const state = require('../utils/state');
const { EXPERTS } = require('./experts');
const { nexusGetScore } = require('./health');
const { NEXUS_MODULES } = require('./modules');
const { assembleSystemPrompt, getScopedTools, layerStats } = require('./layers');

// ── Helpers de expertos ───────────────────────────────────────────────────────

function nexusGetAllExperts() {
  return { ...EXPERTS, ...state.dynamicExperts };
}

function nexusGetModule(name) {
  return NEXUS_MODULES[name] || state.dynamicModules[name] || '';
}

function nexusPickExpert(name) {
  const all = nexusGetAllExperts();
  if (!all[name]) return 'ha_control';
  if (nexusGetScore(name) < 20) {
    console.log(`[nexus] Expert ${name} health=${nexusGetScore(name)} bajo umbral → ha_control`);
    return 'ha_control';
  }
  return name;
}

// ── NEXUS Router (dual: regex gratis + LLM barato) ───────────────────────────

async function nexusRoute(message) {
  const text = (typeof message === 'string' ? message : JSON.stringify(message)).toLowerCase();

  // CAPA 1: regex (0 tokens)
  if (/emergencia|urgente|fallo cr[ií]tico|se ha roto|no arranca|error grave|ayuda urgente/.test(text))
    return { expert: 'emergencia', source: 'regex', confidence: 0.95 };
  // 'dev' SOLO para tareas explícitas de código/Jarvis — evitar coste de Claude Sonnet en tareas generales
  if (/server\.js|index\.html|executor\.js|experts\.js|router\.js|package\.json|add.?on nuevo|crea.*add.?on|github|npm install|node_modules|nueva tool|nuevo endpoint|a[ñn]ade.*tool|desarrolla|implementa.*funci[oó]n|escribe.*c[oó]digo|escribe.*script|modifica.*jarvis|actualiza.*jarvis/.test(text))
    return { expert: 'dev', source: 'regex', confidence: 0.9 };
  if (/automatizaci[oó]n|dashboard|lovelace|card|panel|vista|mushroom|button.card/.test(text))
    return { expert: 'automatizacion', source: 'regex', confidence: 0.85 };
  if (/cuando llegue|cuando salga|cuando me vaya|cuando est[eé] en casa|si no hay nadie|al anochecer|al amanecer|cuando se (abra|cierre|encienda|apague|active)|cuando la temperatura|programa(r)? que|cada ma[ñn]ana|cada noche|cada (lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|crea(r)? (una )?rutina|nueva rutina|si.*llueve|si.*baja de|si.*sube de|a las \d|quiero que.*cuando|haz que.*si |avísame (si|cuando)|notif[ií]came (si|cuando)/.test(text))
    return { expert: 'automatizacion', source: 'regex', confidence: 0.9 };
  if (/diagn[oó]stica|por qu[eé] falla|no funciona|caid[ao]|desconectad|log|error|unavailable/.test(text))
    return { expert: 'diagnostico', source: 'regex', confidence: 0.85 };
  if (/alexa|echo|m[uú]sica|reproduc|altavoz|tts|volumen|pon .*(canci|m[uú]sic|radio|spotify)|announce/.test(text))
    return { expert: 'multimedia', source: 'regex', confidence: 0.85 };
  if (/pvpc|tarifa|consumo|factura|solar|kwh|precio.*luz|cu[aá]nto.*cuesta.*luz|cu[aá]nto.*gast|precio.*electricidad|energ[ií]a|potencia|vatios|watts/.test(text))
    return { expert: 'energia', source: 'regex', confidence: 0.85 };
  if (/c[aá]mara|frigate|reolink|alarma|intrusi|movimiento|presencia|seguridad|hay alguien|est[aá]s? en casa|qui[eé]n est[aá]/.test(text))
    return { expert: 'seguridad', source: 'regex', confidence: 0.85 };
  if (/proxmox|nas|omv|docker|wireguard|nextcloud|vpn|zerotier|red|router|archer|tp.link|contenedor/.test(text))
    return { expert: 'red', source: 'regex', confidence: 0.85 };
  if (/recuerda|aprende|memoria|olvida|qu[eé] sabes|qu[eé] has aprendido|knowledge|patr[oó]n|rutina detectada|mejora tu/.test(text))
    return { expert: 'aprendizaje', source: 'regex', confidence: 0.85 };
  if (/actualiz(a|ate|ate jarvis|a jarvis)|nueva versi[oó]n|instala.*actuali|deploy.*update|refresh.*repo/.test(text))
    return { expert: 'diagnostico', source: 'regex', confidence: 0.9 };
  if (/backup|copia de seguridad|snapshot|actualiza.*add.?on|actualiza.*addon/.test(text))
    return { expert: 'diagnostico', source: 'regex', confidence: 0.85 };
  if (/zigbee|z2m|zigbee2mqtt|coordinador|pareado|pairing/.test(text))
    return { expert: 'diagnostico', source: 'regex', confidence: 0.85 };
  if (/esphome|esp32|esp8266|flashe(a|ar)|compil(a|ar).*firmware|sensor.*diy/.test(text))
    return { expert: 'ha_control', source: 'regex', confidence: 0.85 };
  if (/matter|thread|zha\b|zigbee home|emparejar.*dispositivo|nuevo.*dispositivo/.test(text))
    return { expert: 'ha_control', source: 'regex', confidence: 0.85 };
  if (/est[aá] (en casa|fuera|llegad[oa]|salid[oa])|persona.*detectad|presencia.*hogar/.test(text))
    return { expert: 'seguridad', source: 'regex', confidence: 0.8 };
  if (/climatiza|calefacci[oó]n|aire acondicionado|hvac|termostato|pre.?calent|pre.?enfri|confort t[eé]rmic|temperatura ideal|ahorro.*calef|eficiencia.*clim/.test(text))
    return { expert: 'energia', source: 'regex', confidence: 0.85 };
  if (/programa(r)? la lavadora|mejor hora para|hora m[aá]s barata|cu[aá]ndo poner|horario [oó]ptimo|poner.*lavadora|poner.*calentador|cargar.*coche|riego.*programa/.test(text))
    return { expert: 'energia', source: 'regex', confidence: 0.85 };
  if (/salud.*dispositivo|bater[ií]as|nivel.*bater|device.*health|estado.*zigbee|dispositivos.*ca[ií]dos/.test(text))
    return { expert: 'diagnostico', source: 'regex', confidence: 0.85 };
  if (/anomal[ií]a|sensor.*roto|dispositivo.*ca[ií]do|bater[ií]a baja|salud.*sistema|estado.*dispositivos|qu[eé].*falla|health.*check|l[ií]nea base/.test(text))
    return { expert: 'diagnostico', source: 'regex', confidence: 0.85 };
  if (/predic|cu[aá]ndo.*llego|cu[aá]ndo.*vuelv|hora.*llegar|rutina.*diaria|patr[oó]n.*presencia|ocupaci[oó]n|habitaci[oó]n.*ocupada/.test(text))
    return { expert: 'seguridad', source: 'regex', confidence: 0.8 };
  if (/lee|escribe|lista|archivo|fichero|directorio|config|yaml|json/.test(text) && text.length < 150)
    return { expert: 'archivo', source: 'regex', confidence: 0.8 };
  if (/\brazona\b|an[aá]lisis profundo|piensa.*fondo|explica.*detalle.*por qu[eé]|r1\b|deepseek.?r1|cadena de pensamiento/.test(text))
    return { expert: 'razonamiento', source: 'regex', confidence: 0.9 };
  if (/investiga|analiza|compara|resume|s[ií]ntesis|busca.*informaci[oó]n|qu[eé] opinas|informe|deepseek/.test(text))
    return { expert: 'analisis', source: 'regex', confidence: 0.85 };
  if (/^(hola|ok|vale|gracias|s[ií]|no |perfecto|genial|bien)/.test(text.trim()) && text.length < 30)
    return { expert: 'rapido', source: 'regex', confidence: 0.95 };
  if (text.length < 80 && /enciende|apaga|sube|baja|activa|desactiva|pon|quita|temperatura|humedad|estado de|qu[eé] hay/.test(text))
    return { expert: 'rapido', source: 'regex', confidence: 0.85 };

  // CAPA 1.5: keywords de expertos dinámicos (0 tokens)
  for (const [eName, eCfg] of Object.entries(state.dynamicExperts)) {
    if (eCfg.keywords && eCfg.keywords.length > 0) {
      const kw = eCfg.keywords.join('|');
      if (new RegExp(kw, 'i').test(text)) return { expert: eName, source: 'dynamic_kw', confidence: 0.85 };
    }
  }

  // CAPA 2: LLM barato (~10 tokens de output)
  try {
    const allNames = Object.keys(nexusGetAllExperts()).join('|');
    const result = await callOpenAI(
      BG_MODEL,
      `Clasifica en UNA palabra: ${allNames}. Solo la palabra.`,
      [{ role: 'user', content: text.slice(0, 300) }],
      [],
      10
    );
    const expert = result.text.trim().toLowerCase().split(/[\s\n]/)[0];
    if (nexusGetAllExperts()[expert]) return { expert, source: 'llm', confidence: 0.8 };
  } catch (e) {
    console.log('[nexus] Router LLM error:', e.message);
  }

  return { expert: 'ha_control', source: 'fallback', confidence: 0.6 };
}

// ── NEXUS Ensamblador de prompts (usa layers L0-L4) ───────────────────────────

function nexusAssemblePrompt(expertName) {
  return assembleSystemPrompt(expertName);
}

// ── Tool scoping ──────────────────────────────────────────────────────────────

/**
 * Devuelve las tools en formato OpenAI filtradas para el experto.
 * Si el experto no define tools[], devuelve todas.
 */
function nexusGetToolsForExpert(expertName) {
  const allOpenAITools = state.openAITools || [];
  return getScopedTools(expertName, allOpenAITools);
}

/**
 * Log stats de layers para debugging.
 */
function nexusLogLayerStats(expertName) {
  const stats = layerStats(expertName);
  console.log(`[nexus-layers] expert=${stats.expert} model=${stats.model} modules=${stats.modules} tools=${stats.tools}/${stats.toolsTotal} (↓${stats.reduction})`);
  return stats;
}

module.exports = {
  nexusRoute,
  nexusAssemblePrompt,
  nexusGetAllExperts,
  nexusGetModule,
  nexusPickExpert,
  nexusGetToolsForExpert,
  nexusLogLayerStats
};
