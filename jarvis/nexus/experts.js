'use strict';
const { MODEL, BG_MODEL, CLAUDE_MODEL, DEEPSEEK_MODEL, DEEPSEEK_R1_MODEL } = require('../utils/constants');

// ── Configuración de expertos NEXUS ──────────────────────────────────────────
// Cada experto define: modelo, tokens, iteraciones, módulos activos y tools.
// tools[] limita qué herramientas ve el modelo → menos tokens, mejor foco.
// Si tools === undefined, el experto recibe TODAS las tools (sin scoping).

const EXPERTS = {
  rapido: {
    model: BG_MODEL, maxTokens: 2048, maxIter: 6,
    thinking: false,
    modules: ['base'],
    label: 'Rapido',
    tools: ['get_entities', 'search_entities', 'get_entity_state', 'call_service',
            'save_memory', 'get_memory', 'speak', 'web_search', 'fetch_url',
            'list_directory', 'read_file', 'show_house_status']
  },

  ha_control: {
    model: MODEL, maxTokens: 4096, maxIter: 8,
    thinking: true,
    modules: ['base', 'philosophy', 'ha_control', 'ha_internals', 'ha_config_engineering', 'clima', 'presencia', 'filesystem', 'inamovible'],
    label: 'Control HA',
    tools: ['get_entities', 'search_entities', 'get_entity_state', 'call_service',
            'get_history', 'get_logbook', 'get_automations', 'create_automation',
            'edit_automation', 'delete_automation', 'reload_config',
            'read_file', 'write_file', 'patch_file', 'validate_yaml', 'list_directory',
            'save_memory', 'get_memory', 'learn', 'web_search', 'ha_knowledge',
            'scan_installation', 'check_config', 'speak', 'telegram_send', 'rollback',
            'show_house_status', 'generate_image', 'generate_image_gemini', 'dev_workspace',
            'edit_script', 'delete_script', 'mqtt_publish', 'zigbee_manage',
            'score_installation', 'render_floorplan', 'manage_users', 'esphome_manage',
            'backup_restore', 'notify_all', 'energy_query',
            'zha_matter_manage', 'system_info',
            'climate_optimize', 'presence_predict', 'anomaly_detect',
            'smart_schedule', 'device_health',
            'camera_analyze', 'integration_repair', 'multi_room_audio', 'area_manage',
            'weather_forecast', 'input_manage', 'automation_analytics']
  },

  diagnostico: {
    model: MODEL, maxTokens: 4096, maxIter: 10,
    thinking: true,
    modules: ['base', 'perseverance', 'ha_control', 'ha_internals', 'ha_config_engineering', 'diagnostico', 'anomalias', 'filesystem', 'inamovible'],
    label: 'Diagnostico',
    tools: ['get_entities', 'search_entities', 'get_entity_state', 'get_history', 'get_logbook',
            'get_system_logs', 'get_error_log', 'check_config', 'web_search', 'web_search_native', 'fetch_url',
            'read_file', 'learn', 'ha_supervisor', 'network', 'get_notifications',
            'get_repairs', 'scan_installation', 'ha_knowledge', 'rollback', 'validate_yaml',
            'score_installation', 'esphome_manage', 'backup_restore',
            'zha_matter_manage', 'system_info', 'anomaly_detect', 'device_health',
            'integration_repair']
  },

  automatizacion: {
    model: MODEL, maxTokens: 4096, maxIter: 8,
    thinking: true,
    modules: ['base', 'philosophy', 'natural_automation', 'automation', 'ha_internals', 'ha_config_engineering', 'ha_control', 'filesystem', 'inamovible'],
    label: 'Automatizacion',
    tools: ['get_automations', 'create_automation', 'edit_automation', 'delete_automation',
            'simulate_automation', 'reload_config', 'check_config',
            'get_dashboards', 'get_dashboard_config', 'update_dashboard', 'review_dashboard',
            'get_installed_frontend', 'search_hacs_resources', 'install_hacs_resource',
            'read_file', 'write_file', 'append_file', 'patch_file', 'rollback',
            'validate_yaml', 'list_directory', 'save_memory', 'learn', 'ha_knowledge',
            'dev_workspace', 'edit_script', 'delete_script', 'automation_analytics']
  },

  archivo: {
    model: MODEL, maxTokens: 3072, maxIter: 6,
    thinking: false,
    modules: ['base', 'ha_config_engineering', 'filesystem', 'inamovible'],
    label: 'Archivos',
    tools: ['read_file', 'write_file', 'append_file', 'list_directory', 'patch_file',
            'rollback', 'validate_yaml', 'check_config', 'reload_config', 'fetch_url', 'web_search',
            'local_file']
  },

  emergencia: {
    model: MODEL, maxTokens: 6144, maxIter: 12,
    thinking: true,
    modules: ['base', 'perseverance', 'emergency', 'ha_config_engineering', 'diagnostico', 'ha_internals', 'ha_control', 'filesystem', 'inamovible'],
    label: 'Emergencia',
    tools: ['get_entities', 'get_entity_state', 'call_service', 'get_system_logs',
            'get_error_log', 'read_file', 'write_file', 'reload_config', 'check_config',
            'ha_supervisor', 'emergency_config', 'learn', 'rollback', 'scan_installation',
            'telegram_send', 'validate_yaml', 'backup_restore', 'notify_all']
  },

  dev: {
    model: CLAUDE_MODEL, maxTokens: 3500, maxIter: 5,
    thinking: 'max',
    modules: ['base', 'philosophy', 'dev', 'inamovible'],
    label: 'Desarrollo',
    tools: ['read_file', 'write_file', 'append_file', 'list_directory', 'patch_file',
            'rollback', 'exec_command', 'update_self', 'create_addon', 'github_push',
            'analyze_github_repos', 'web_search', 'web_search_native', 'fetch_url', 'ha_supervisor',
            'validate_yaml', 'update_ui', 'nexus_manage', 'create_custom_tool',
            'run_custom_tool', 'house_3d_map', 'learn', 'knowledge_db',
            'generate_image', 'generate_image_gemini', 'dev_workspace',
            'render_floorplan', 'local_file', 'esphome_manage']
  },

  multimedia: {
    model: MODEL, maxTokens: 2048, maxIter: 6,
    thinking: false,
    modules: ['base', 'multimedia', 'ha_control', 'filesystem', 'inamovible'],
    label: 'Multimedia',
    tools: ['call_service', 'speak', 'alexa_bidirectional', 'get_entities',
            'get_entity_state', 'generate_image', 'image_edit', 'telegram_send_image',
            'web_search', 'fetch_url', 'save_memory', 'read_file', 'notify_all',
            'multi_room_audio']
  },

  energia: {
    model: MODEL, maxTokens: 4096, maxIter: 8,
    thinking: true,
    modules: ['base', 'energia', 'clima', 'ha_control', 'filesystem', 'inamovible'],
    label: 'Energia',
    tools: ['get_entities', 'get_entity_state', 'get_history', 'get_logbook', 'call_service',
            'template_render', 'create_automation', 'analyze_patterns',
            'save_memory', 'learn', 'web_search', 'ha_knowledge',
            'knowledge_db', 'read_file', 'energy_query', 'climate_optimize',
            'smart_schedule', 'device_health', 'weather_forecast']
  },

  seguridad: {
    model: MODEL, maxTokens: 4096, maxIter: 8,
    thinking: true,
    modules: ['base', 'seguridad_casa', 'presencia', 'ha_control', 'diagnostico', 'filesystem', 'inamovible'],
    label: 'Seguridad',
    tools: ['get_entities', 'get_entity_state', 'call_service', 'get_history', 'get_logbook',
            'telegram_send', 'telegram_send_image', 'telegram_get_updates',
            'get_automations', 'create_automation', 'reload_config', 'get_system_logs',
            'learn', 'network', 'save_memory', 'manage_users', 'notify_all',
            'presence_predict', 'anomaly_detect', 'camera_analyze']
  },

  red: {
    model: MODEL, maxTokens: 4096, maxIter: 8,
    thinking: true,
    modules: ['base', 'perseverance', 'red_infra', 'proxmox', 'diagnostico', 'filesystem', 'inamovible'],
    label: 'Red e Infra',
    tools: ['network', 'proxmox_api', 'agent_chat', 'agent_communicate', 'web_search',
            'fetch_url', 'read_file', 'write_file', 'exec_command', 'get_system_logs',
            'ha_supervisor', 'learn', 'knowledge_db', 'mqtt_publish', 'zigbee_manage',
            'esphome_manage', 'system_info']
  },

  aprendizaje: {
    model: MODEL, maxTokens: 4096, maxIter: 8,
    thinking: true,
    modules: ['base', 'aprendizaje', 'ha_control', 'filesystem', 'inamovible'],
    label: 'Aprendizaje',
    tools: ['get_memory', 'save_memory', 'delete_memory', 'learn', 'knowledge_db',
            'analyze_patterns', 'proactive_thought', 'get_entities', 'web_search',
            'web_search_native', 'get_history', 'scan_installation']
  },

  // ── Nucleos DeepSeek V4 ──────────────────────────────────────────────────────

  analisis: {
    model: DEEPSEEK_MODEL, maxTokens: 4096, maxIter: 8,
    thinking: false,
    modules: ['base', 'aprendizaje'],
    label: 'Analisis (V4 Flash)',
    // Nucleo de investigacion: busca, lee, sintetiza. No modifica HA.
    tools: ['web_search', 'web_search_native', 'fetch_url', 'knowledge_db',
            'get_memory', 'save_memory', 'learn', 'analyze_patterns',
            'get_entities', 'get_entity_state', 'get_history',
            'read_file', 'list_directory', 'get_system_logs', 'get_error_log',
            'scan_installation', 'ha_knowledge', 'proactive_thought']
  },

  razonamiento: {
    model: DEEPSEEK_R1_MODEL, maxTokens: 16000, maxIter: 3,
    thinking: true,
    modules: ['base_r1'],
    label: 'Razonamiento (V4 Pro)',
    tools: []
  }
};

module.exports = { EXPERTS };
