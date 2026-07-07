'use strict';
const fs = require('fs');
const path = require('path');
const { callLLM } = require('../utils/llm');
const { loadJSON, saveJSON } = require('../utils/persistence');
const C = require('../utils/constants');
const state = require('../utils/state');

const KNOWLEDGE_TOPICS = [
  // HA Internals — arquitectura y funcionamiento profundo (PRIORIDAD)
  'Home Assistant configuration.yaml estructura completa includes packages',
  'Home Assistant .storage directorio archivos internos entity_registry device_registry',
  'Home Assistant automation platform internals cómo carga automations.yaml restored state',
  'Home Assistant integration lifecycle setup unload reload config_entries',
  'Home Assistant entity registry unique_id entity_id platform disabled hidden',
  'Home Assistant Supervisor API endpoints addons core host network',
  'Home Assistant Lovelace dashboard storage mode yaml mode interno',
  'Home Assistant YAML errores comunes indentación duplicados includes vacíos',
  'Home Assistant Jinja2 templates avanzados states attributes time triggers',
  'Home Assistant custom_components estructura __init__.py manifest.json config_flow',
  'Home Assistant event bus state_changed call_service event trigger',
  'Home Assistant recorder database history statistics purge',
  'Home Assistant areas zones persons device_tracker presence detection',
  'Home Assistant REST API endpoints authentication long-lived tokens webhook',
  'Home Assistant add-on development Dockerfile config.yaml bashio ingress',
  'Home Assistant backup restore parcial completo snapshot config .storage',
  'Home Assistant MQTT discovery auto-configuration topics payload',
  'Home Assistant scripts yaml estructura delay wait_template choose repeat',
  'Home Assistant scenes snapshot restore entities state attributes',
  'Home Assistant input_boolean input_number input_select helpers automation state',
  // Industrial
  'Modbus TCP configuración Home Assistant integración',
  'OPC-UA servidor cliente configurar raspberry',
  'PLC Siemens S7 comunicación MQTT Node-RED',
  'sensores 4-20mA conectar ESP32 ADC',
  'variador frecuencia VFD Modbus registros',
  'PROFINET configuración básica',
  'EtherCAT vs EtherNet/IP diferencias',
  'BACnet HVAC integración Home Assistant',
  'PID control temperatura Home Assistant',
  'SCADA open source alternativas Ignition',
  // Domótica avanzada
  'Home Assistant últimas novedades 2026',
  'ESPHome sensores industriales',
  'Zigbee2MQTT mejores prácticas red grande',
  'Matter Thread estado actual compatibilidad',
  'Frigate detección objetos configuración',
  'Home Assistant energy dashboard solar',
  'automatización avanzada templates Jinja2',
  'Node-RED vs HA automations cuándo usar',
  // Redes y seguridad
  'VLAN IoT separar red domótica',
  'firewall OT IT mejores prácticas',
  'VPN WireGuard Home Assistant acceso remoto',
  // Hardware
  'ESP32 S3 mejores proyectos ESPHome',
  'Shelly Pro industrial vs doméstico',
  'Sonoff NSPanel Pro custom firmware'
];

let knowledgeTopicIndex = 0;

async function knowledgeExpansionLoop() {
  try {
    if (!C.OPENAI_API_KEY) return;

    // Elegir tema siguiente (rotativo)
    const topic = KNOWLEDGE_TOPICS[knowledgeTopicIndex % KNOWLEDGE_TOPICS.length];
    knowledgeTopicIndex++;

    // Comprobar si ya tenemos conocimiento de este tema
    const KB_DIR = path.join(C.DATA_DIR, 'knowledge');
    const KB_INDEX = path.join(KB_DIR, 'index.json');
    if (!fs.existsSync(KB_DIR)) fs.mkdirSync(KB_DIR, { recursive: true });
    const index = loadJSON(KB_INDEX, { entries: [], categories: {}, totalEntries: 0 });

    // Buscar si ya existe algo similar
    const topicWords = topic.toLowerCase().split(' ');
    const alreadyKnown = index.entries.some(e => {
      const entryText = `${e.title} ${(e.tags || []).join(' ')}`.toLowerCase();
      return topicWords.filter(w => entryText.includes(w)).length >= 3;
    });

    if (alreadyKnown) {
      console.log(`[knowledge] Ya conozco sobre: ${topic.slice(0, 40)}... saltando.`);
      return;
    }

    console.log(`[knowledge] Investigando: ${topic}`);

    const knowledgeTools = state.openAITools.filter(t => t.function.name === 'knowledge_db');
    const knowledgePrompt = `Genera una entrada de conocimiento sobre: "${topic}"

Usa knowledge_db con action "add" y crea una entrada con:
- title: título claro y descriptivo
- category: la más apropiada (industrial, domotica, protocolos, networking, hardware, energia, seguridad, integraciones)
- content: explicación práctica (qué es, cómo funciona, cómo se configura, ejemplo de uso). Máximo 500 caracteres.
- tags: 4-6 tags relevantes para búsqueda
- importance: high si es muy útil para domótica/industrial, medium si es complementario
- source: "auto-aprendizaje"

Solo información VERIFICABLE y PRÁCTICA. Nada genérico.`;

    let knowResult;
    try {
      knowResult = await callLLM(C.BG_MODEL, 'Eres un experto técnico. Genera conocimiento estructurado y práctico. Responde SOLO con la llamada a knowledge_db. Español. Sé conciso pero completo.', [{ role: 'user', content: knowledgePrompt }], knowledgeTools, 800);
    } catch (err) {
      console.log(`[knowledge] Error API: ${err.message}`);
      return;
    }

    for (const tc of knowResult.toolCalls) {
      if (tc.name === 'knowledge_db') await state.executeTool('knowledge_db', tc.input);
    }

    console.log(`[knowledge] +1 entrada almacenada. Total: ${index.totalEntries + knowResult.toolCalls.length} entradas en la base.`);
  } catch (err) {
    console.log(`[knowledge] Error: ${err.message}`);
  }
}

async function distillLearnings() {
  try {
    if (!C.OPENAI_API_KEY || state.learnings.length < 5) return;
    console.log(`[distill] Destilando ${state.learnings.length} learnings en reglas...`);

    const prompt = `Eres Jarvis. Tienes ${state.learnings.length} aprendizajes acumulados de tu instalación de Home Assistant.
Tu tarea: convertirlos en REGLAS ACCIONABLES cortas (máx 25 palabras cada una).
Una regla accionable empieza con un verbo y dice exactamente qué hacer o qué evitar.

Ejemplos de BUENAS reglas:
- "Cuando Alexa Media Player cae tras reinicio de HA, recargar la integración vía config_entries API"
- "Las bombillas del salón son Zigbee vía Z2M — si unavailable, cortar/dar corriente"
- "PVPC se auto-recupera solo — no recargar hasta 10min después del error"
- "El ESP_Modulo_2_Puerta necesita IP estática — suele caer cuando el router asigna nueva IP"

LEARNINGS:
${state.learnings.slice(-50).map((l, i) => `[${i}] (${l.type}) ${l.context}: ${l.lesson}${l.solution ? ' → ' + l.solution : ''}`).join('\n')}

Responde SOLO con un JSON array de strings (las reglas). Máx 20 reglas. Solo las más útiles y accionables.`;

    let distillResult;
    try {
      distillResult = await callLLM(C.BG_MODEL, null, [{ role: 'user', content: prompt }], null, 1024);
    } catch (err) {
      console.log(`[distill] Error API: ${err.message}`);
      return;
    }
    const match = distillResult.text.match(/\[[\s\S]*\]/);
    if (match) {
      const rules = JSON.parse(match[0]);
      saveJSON(path.join(C.DATA_DIR, 'distilled_rules.json'), rules);
      console.log(`[distill] ${rules.length} reglas guardadas.`);
    }
  } catch (err) {
    console.log(`[distill] Error: ${err.message}`);
  }
}

module.exports = { knowledgeExpansionLoop, distillLearnings };
