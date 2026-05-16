'use strict';
const { MODEL, BG_MODEL, CLAUDE_MODEL } = require('../utils/constants');

// ── Configuración de expertos NEXUS ──────────────────────────────────────────
// Cada experto define: modelo, tokens, iteraciones, módulos activos y tools.
// tools[] limita qué herramientas ve el modelo → menos tokens, mejor foco.
// Si tools === undefined, el experto recibe TODAS las tools (sin scoping).

const EXPERTS = {
  rapido: {
    model: BG_MODEL, maxTokens: 2048, maxIter: 6,
    modules: ['base', 'autonomy', 'optimization'],
    label: 'Rápido',
    tools: ['get_entities', 'search_entities', 'get_entity_state', 'call_service',
            'save_memory', 'get_memory', 'speak', 'web_search', 'fetch_url',
            'list_directory', 'read_file']
  },

  ha_control: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'philosophy', 'ha_control', 'ha_internals', 'ha_config_engineering', 'autonomy', 'optimization', 'filesystem', 'inamovible'],
    label: 'Control HA',
    tools: ['get_entities', 'search_entities', 'get_entity_state', 'call_service',
            'get_history', 'get_automations', 'create_automation', 'reload_config',
            'read_file', 'write_file', 'patch_file', 'validate_yaml', 'list_directory',
            'save_memory', 'get_memory', 'learn', 'web_search', 'ha_knowledge',
            'scan_installation', 'check_config', 'speak', 'telegram_send', 'rollback']
  },

  diagnostico: {
    model: MODEL, maxTokens: 8192, maxIter: 20,
    modules: ['base', 'perseverance', 'ha_control', 'ha_internals', 'ha_config_engineering', 'diagnostico', 'optimization', 'filesystem', 'inamovible'],
    label: 'Diagnóstico',
    tools: ['get_entities', 'search_entities', 'get_entity_state', 'get_history',
            'get_system_logs', 'get_error_log', 'check_config', 'web_search', 'fetch_url',
            'read_file', 'learn', 'ha_supervisor', 'network', 'get_notifications',
            'get_repairs', 'scan_installation', 'ha_knowledge', 'rollback', 'validate_yaml']
  },

  automatizacion: {
    model: MODEL, maxTokens: 8192, maxIter: 15,
    modules: ['base', 'philosophy', 'automation', 'ha_internals', 'ha_config_engineering', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Automatización',
    tools: ['get_automations', 'create_automation', 'reload_config', 'check_config',
            'get_dashboards', 'get_dashboard_config', 'update_dashboard', 'review_dashboard',
            'get_installed_frontend', 'search_hacs_resources', 'install_hacs_resource',
            'read_file', 'write_file', 'append_file', 'patch_file', 'rollback',
            'validate_yaml', 'list_directory', 'save_memory', 'learn', 'ha_knowledge']
  },

  archivo: {
    model: MODEL, maxTokens: 4096, maxIter: 10,
    modules: ['base', 'ha_config_engineering', 'filesystem', 'autonomy', 'optimization', 'inamovible'],
    label: 'Archivos',
    tools: ['read_file', 'write_file', 'append_file', 'list_directory', 'patch_file',
            'rollback', 'validate_yaml', 'fetch_url', 'web_search']
  },

  emergencia: {
    model: MODEL, maxTokens: 8192, maxIter: 20,
    modules: ['base', 'perseverance', 'emergency', 'ha_config_engineering', 'diagnostico', 'ha_internals', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Emergencia',
    tools: ['get_entities', 'get_entity_state', 'call_service', 'get_system_logs',
            'get_error_log', 'read_file', 'write_file', 'reload_config', 'check_config',
            'ha_supervisor', 'emergency_config', 'learn', 'rollback', 'scan_installation',
            'telegram_send', 'validate_yaml']
  },

  dev: {
    model: CLAUDE_MODEL, maxTokens: 8192, maxIter: 20,
    modules: ['base', 'philosophy', 'dev', 'ha_internals', 'ha_config_engineering', 'filesystem', 'autonomy', 'optimization', 'inamovible'],
    label: 'Desarrollo',
    tools: ['read_file', 'write_file', 'append_file', 'list_directory', 'patch_file',
            'rollback', 'exec_command', 'update_self', 'create_addon', 'github_push',
            'analyze_github_repos', 'web_search', 'fetch_url', 'ha_supervisor',
            'validate_yaml', 'update_ui', 'nexus_manage', 'create_custom_tool',
            'run_custom_tool', 'house_3d_map', 'learn', 'knowledge_db']
  },

  multimedia: {
    model: MODEL, maxTokens: 4096, maxIter: 10,
    modules: ['base', 'autonomy', 'multimedia', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Multimedia',
    tools: ['call_service', 'speak', 'alexa_bidirectional', 'get_entities',
            'get_entity_state', 'generate_image', 'telegram_send_image',
            'web_search', 'fetch_url', 'save_memory']
  },

  energia: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'autonomy', 'energia', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Energía',
    tools: ['get_entities', 'get_entity_state', 'get_history', 'call_service',
            'analyze_patterns', 'save_memory', 'learn', 'web_search', 'ha_knowledge',
            'knowledge_db', 'read_file']
  },

  seguridad: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'autonomy', 'seguridad_casa', 'ha_control', 'diagnostico', 'optimization', 'filesystem', 'inamovible'],
    label: 'Seguridad',
    tools: ['get_entities', 'get_entity_state', 'call_service', 'get_history',
            'telegram_send', 'telegram_send_image', 'telegram_get_updates',
            'get_automations', 'create_automation', 'reload_config', 'get_system_logs',
            'learn', 'network', 'save_memory']
  },

  red: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'perseverance', 'red_infra', 'proxmox', 'diagnostico', 'optimization', 'filesystem', 'inamovible'],
    label: 'Red e Infra',
    tools: ['network', 'proxmox_api', 'agent_chat', 'agent_communicate', 'web_search',
            'fetch_url', 'read_file', 'write_file', 'exec_command', 'get_system_logs',
            'ha_supervisor', 'learn', 'knowledge_db']
  },

  aprendizaje: {
    model: MODEL, maxTokens: 6144, maxIter: 15,
    modules: ['base', 'autonomy', 'aprendizaje', 'ha_control', 'optimization', 'filesystem', 'inamovible'],
    label: 'Aprendizaje',
    tools: ['get_memory', 'save_memory', 'delete_memory', 'learn', 'knowledge_db',
            'analyze_patterns', 'proactive_thought', 'get_entities', 'web_search',
            'get_history', 'scan_installation']
  }
};

module.exports = { EXPERTS };
