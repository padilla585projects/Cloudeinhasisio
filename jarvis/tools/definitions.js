'use strict';

// ── Definiciones de tools del agente (63 tools) ──────────────────────────────
// Este archivo es puro datos — solo exporta el array tools[].
// Los tool calls reales están en tools/executor.js

const tools = [
  // ─── Dispositivos ───
  {
    name: 'get_entities',
    description: 'Lista entidades de HA filtradas por dominio. SIEMPRE especifica dominio.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Dominio: light, switch, sensor, climate, media_player, automation, cover, fan, camera, binary_sensor, script, scene' }
      }
    }
  },
  {
    name: 'search_entities',
    description: 'Busca entidades por nombre parcial. Útil cuando el usuario dice un nombre de habitación o dispositivo.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto a buscar: "salon", "cocina", "temperatura", etc.' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_entity_state',
    description: 'Estado actual y atributos de una entidad específica',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Ej: light.salon, switch.cocina' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'call_service',
    description: 'Ejecuta un servicio de HA. Para controlar dispositivos, ejecutar scripts, activar escenas, etc.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Dominio: light, switch, climate, media_player, script, scene, etc.' },
        service: { type: 'string', description: 'Servicio: turn_on, turn_off, toggle, set_temperature, etc.' },
        entity_id: { type: 'string', description: 'ID de la entidad' },
        service_data: { type: 'object', description: 'Datos adicionales: {"brightness": 128, "color_temp": 300}' }
      },
      required: ['domain', 'service']
    }
  },
  {
    name: 'get_history',
    description: 'Historial de estados de una entidad (últimas N horas). Usa max_records para limitar el resultado.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        hours: { type: 'number', description: 'Horas hacia atrás (max 48, default 6)' },
        max_records: { type: 'number', description: 'Máximo de registros a devolver (default 200)' }
      },
      required: ['entity_id']
    }
  },
  {
    name: 'get_logbook',
    description: 'Lee el logbook de HA: eventos de entidades (encendido, apagado, disparado, etc.) más legibles que get_history. Útil para diagnóstico y auditoría de automatizaciones.',
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Horas hacia atrás (max 72, default 24)' },
        entity_id: { type: 'string', description: 'Filtrar por entidad (opcional)' },
        domain: { type: 'string', description: 'Filtrar por dominio, ej: automation, light (opcional)' }
      }
    }
  },

  // ─── Automatizaciones ───
  {
    name: 'get_automations',
    description: 'Lista todas las automatizaciones con su estado',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'create_automation',
    description: 'Crea una nueva automatización escribiendo directamente en automations.yaml. Proporciona el YAML completo de la automatización.',
    input_schema: {
      type: 'object',
      properties: {
        yaml_content: { type: 'string', description: 'Contenido YAML de la automatización (sin el guión inicial). Incluye id, alias, trigger, condition, action.' },
        description: { type: 'string', description: 'Descripción breve de lo que hace la automatización' }
      },
      required: ['yaml_content', 'description']
    }
  },
  {
    name: 'reload_config',
    description: 'Recarga la configuración de HA después de modificar archivos. Especifica qué recargar.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['automations', 'scripts', 'scenes', 'groups', 'core', 'all'], description: 'Qué recargar' }
      },
      required: ['target']
    }
  },

  // ─── Filesystem ───
  {
    name: 'read_file',
    description: 'Lee un archivo del sistema. Rutas válidas: /config/... (configuración HA), /addons/... (add-ons), /share/... (compartido), /data/... (datos del agente). Para archivos grandes (automations.yaml ~1200 líneas) usa offset para paginar.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Ruta absoluta del archivo. Ej: /config/configuration.yaml, /config/automations.yaml' },
        lines:  { type: 'number', description: 'Número máximo de líneas a leer (default: 500). Aumentar para archivos grandes.' },
        offset: { type: 'number', description: 'Línea desde la que empezar (0-based, default: 0). Usar para paginar: offset:500 lee a partir de la línea 500.' }
      },
      required: ['filepath']
    }
  },
  {
    name: 'write_file',
    description: 'Escribe o crea un archivo. Solo permitido en /config, /share y /data. CUIDADO: esto sobreescribe el archivo completo.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Ruta absoluta del archivo' },
        content: { type: 'string', description: 'Contenido completo del archivo' }
      },
      required: ['filepath', 'content']
    }
  },
  {
    name: 'append_file',
    description: 'Añade contenido al final de un archivo existente. Útil para añadir automatizaciones, scripts, etc.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Ruta absoluta del archivo' },
        content: { type: 'string', description: 'Contenido a añadir al final' }
      },
      required: ['filepath', 'content']
    }
  },
  {
    name: 'patch_file',
    description: 'Edición quirúrgica: busca texto EXACTO en un archivo y lo reemplaza. SIEMPRE preferir esto a write_file para modificar archivos existentes — nunca sobrescribe el archivo completo. Si old_str no se encuentra, falla sin tocar el archivo.',
    input_schema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'Ruta absoluta del archivo a editar' },
        old_str: { type: 'string', description: 'Fragmento EXACTO a buscar (copia-pega del read_file, con indentación incluida). Debe ser único en el archivo.' },
        new_str: { type: 'string', description: 'Texto que reemplaza a old_str. Mantén indentación de 2 espacios para YAML de HA.' },
        expected_replacements: { type: 'number', description: 'Ocurrencias esperadas (default: 1). Si hay más o menos, falla para evitar ediciones inesperadas.' }
      },
      required: ['filepath', 'old_str', 'new_str']
    }
  },
  {
    name: 'validate_yaml',
    description: 'Valida sintaxis YAML y estructura específica de HA ANTES de escribir. Usa siempre antes de patch_file/write_file/append_file en archivos .yaml de HA. Devuelve el error con número de línea exacto.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Contenido YAML a validar' },
        file_type: { type: 'string', enum: ['automations', 'scripts', 'scenes', 'configuration', 'generic'], description: 'Tipo: activa validaciones específicas de HA (automations requiere trigger+action, scripts requiere sequence, etc.)' }
      },
      required: ['content', 'file_type']
    }
  },
  {
    name: 'list_directory',
    description: 'Lista archivos y carpetas de un directorio',
    input_schema: {
      type: 'object',
      properties: {
        dirpath: { type: 'string', description: 'Ruta del directorio. Ej: /config, /config/custom_components' },
        recursive: { type: 'boolean', description: 'Listar recursivamente (default: false)' }
      },
      required: ['dirpath']
    }
  },

  // ─── Internet ───
  {
    name: 'web_search',
    description: 'Busca información en internet. Útil para documentación de HA, integraciones, solucionar errores, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Consulta de búsqueda. Ej: "home assistant automation sunrise trigger", "esphome esp32 temperature sensor"' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_url',
    description: 'Obtiene el contenido de una URL específica (documentación, APIs, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL a consultar' },
        max_chars: { type: 'number', description: 'Máximo de caracteres a devolver (default: 5000)' }
      },
      required: ['url']
    }
  },

  // ─── Memoria y aprendizaje ───
  {
    name: 'save_memory',
    description: 'Guarda una nota en memoria permanente. Usa para: preferencias del usuario, info de la instalación, rutinas, nombres de dispositivos, etc.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'La nota a recordar' },
        category: { type: 'string', enum: ['preferencia', 'rutina', 'dispositivo', 'configuracion', 'error_conocido', 'solucion', 'patron', 'mejora_pendiente'], description: 'Categoría' }
      },
      required: ['note', 'category']
    }
  },
  {
    name: 'get_memory',
    description: 'Consulta la memoria permanente. Filtra por categoría si lo necesitas.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filtrar por categoría (opcional)' },
        search: { type: 'string', description: 'Buscar texto en las notas (opcional)' }
      }
    }
  },
  {
    name: 'delete_memory',
    description: 'Elimina una nota de la memoria por su índice',
    input_schema: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Índice de la nota (empieza en 0)' } },
      required: ['index']
    }
  },
  {
    name: 'learn',
    description: 'Registra un aprendizaje: algo que funcionó, algo que falló, un patrón descubierto. Esto te hace más inteligente con el tiempo.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['success', 'error', 'pattern', 'optimization'], description: 'Tipo de aprendizaje' },
        context: { type: 'string', description: 'Qué estabas haciendo' },
        lesson: { type: 'string', description: 'Qué aprendiste' },
        solution: { type: 'string', description: 'Solución si aplica' }
      },
      required: ['type', 'context', 'lesson']
    }
  },

  // ─── Instalación ───
  {
    name: 'scan_installation',
    description: 'Escanea toda la instalación de HA: entidades, integraciones, add-ons, archivos de config, sistema. Actualiza el mapa interno. Usar cuando necesites info actualizada del sistema.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'check_config',
    description: 'Verifica que la configuración de HA es válida (equivalente a comprobar config en HA)',
    input_schema: { type: 'object', properties: {} }
  },

  // ─── Dashboards / Lovelace ───
  {
    name: 'get_dashboards',
    description: 'Lista todos los dashboards (paneles) de Lovelace configurados en HA',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_dashboard_config',
    description: 'Obtiene la configuración completa de un dashboard (vistas, cards, layout). Usa para analizar y sugerir mejoras.',
    input_schema: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'ID del dashboard. Usar "lovelace" para el default, o el id específico (ej: "lovelace-climate")' }
      },
      required: ['dashboard_id']
    }
  },
  {
    name: 'update_dashboard',
    description: 'Actualiza la configuración de un dashboard completo o una vista específica. CUIDADO: sobreescribe la config del dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        dashboard_id: { type: 'string', description: 'ID del dashboard' },
        config: { type: 'object', description: 'Configuración completa del dashboard en formato Lovelace (title, views, etc.)' }
      },
      required: ['dashboard_id', 'config']
    }
  },
  {
    name: 'get_installed_frontend',
    description: 'Lista recursos frontend instalados (custom cards, temas, HACS frontend). Útil para saber qué cards tiene el usuario.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'search_hacs_resources',
    description: 'Busca cards, integraciones o herramientas disponibles en HACS o la comunidad HA. Usa web_search internamente.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Qué buscar: "mushroom cards", "mini-graph-card", "weather card animated", etc.' },
        type: { type: 'string', enum: ['frontend', 'integration', 'all'], description: 'Tipo de recurso a buscar' }
      },
      required: ['query']
    }
  },
  {
    name: 'install_hacs_resource',
    description: 'Instala una card o integración custom descargándola. Para cards: descarga JS a /config/www/ y registra como recurso Lovelace. Para integraciones: descarga a /config/custom_components/.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL directa al archivo JS (card) o al zip/repo de GitHub' },
        name: { type: 'string', description: 'Nombre del recurso (ej: "mini-graph-card")' },
        type: { type: 'string', enum: ['frontend', 'integration'], description: 'Tipo: frontend (card/tema) o integration' }
      },
      required: ['url', 'name', 'type']
    }
  },
  {
    name: 'ha_knowledge',
    description: 'Consulta documentación y conocimiento experto sobre Home Assistant. Busca en la wiki/docs oficial, changelogs, bugs conocidos, mejores prácticas.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Tema a consultar: "automation triggers", "template sensors", "ESPHome", "zigbee network", "energy dashboard", etc.' },
        version: { type: 'string', description: 'Versión específica de HA si aplica (ej: "2024.12")' }
      },
      required: ['topic']
    }
  },

  // ─── Proxmox ───
  {
    name: 'proxmox_api',
    description: 'Ejecuta comandos en Proxmox VE via API REST. Puede ver VMs, contenedores, recursos, almacenamiento, snapshots, backups. El HA está en una VM de Proxmox.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get_status', 'list_vms', 'vm_status', 'start_vm', 'stop_vm', 'snapshot_vm', 'get_resources', 'get_storage', 'get_network', 'custom'], description: 'Acción a ejecutar en Proxmox' },
        vmid: { type: 'number', description: 'ID de la VM (si aplica)' },
        endpoint: { type: 'string', description: 'Endpoint custom para action=custom (ej: /nodes/pve/status)' },
        params: { type: 'object', description: 'Parámetros adicionales para la llamada' }
      },
      required: ['action']
    }
  },

  // ─── Logs del sistema ───
  {
    name: 'get_system_logs',
    description: 'Lee los logs del sistema de HA (core, supervisor, add-ons, host). CLAVE para diagnosticar problemas, ver errores, entender qué pasa en el sistema.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['core', 'supervisor', 'host', 'addon'], description: 'Fuente de logs: core (HA), supervisor, host (OS), addon (un add-on específico)' },
        addon_slug: { type: 'string', description: 'Slug del add-on si source=addon (ej: "jarvis_ai_agent")' },
        lines: { type: 'number', description: 'Número de líneas a obtener (default: 100, max: 500)' },
        filter: { type: 'string', description: 'Filtrar logs que contengan este texto (ej: "ERROR", "WARNING", un nombre de integración)' }
      },
      required: ['source']
    }
  },
  {
    name: 'get_error_log',
    description: 'Lee el archivo home-assistant.log directamente. Contiene errores, warnings y debug de HA core. Útil para ver problemas de integraciones.',
    input_schema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'Últimas N líneas (default: 100)' },
        filter: { type: 'string', description: 'Filtrar por texto (ej: "ERROR", "zigbee", nombre de integración)' }
      }
    }
  },

  // ─── Notificaciones y Reparaciones ───
  {
    name: 'get_notifications',
    description: 'Lee las notificaciones persistentes de HA (avisos del sistema, integraciones, actualizaciones). Son las que aparecen en la campana del panel lateral.',
    input_schema: {
      type: 'object',
      properties: {
        dismiss: { type: 'string', description: 'ID de notificación a descartar (opcional). Si se pasa, descarta esa notificación.' }
      }
    }
  },
  {
    name: 'get_repairs',
    description: 'Lee las reparaciones sugeridas por HA (issues del sistema de resolución). Son los avisos tipo "Reparar" que aparecen en Configuración → Reparaciones. Incluye problemas detectados, sugerencias y su estado.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },

  // ─── Voz / TTS ───
  {
    name: 'speak',
    description: 'Habla en voz alta a través de los altavoces de la casa. Usa TTS de HA con Piper (español) o los Echo de Alexa. Úsalo cuando quieras que Jarvis diga algo en voz alta sin que el usuario tenga que leerlo — alarmas, avisos, respuestas de voz, confirmaciones.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Texto a decir en voz alta' },
        target: { type: 'string', description: 'Altavoz donde hablar: "alexa_salon", "alexa_cocina", "alexa_dormitorio", "alexa_garaje", "all_alexa", "ha_tts" (Piper). Por defecto: "ha_tts".' },
        language: { type: 'string', description: 'Idioma: "es" (default) o "en"' },
      },
      required: ['message']
    }
  },

  // ─── Telegram ───
  {
    name: 'telegram_send',
    description: 'Envía un mensaje por Telegram al usuario. Usa el servicio notify de HA con el bot ya configurado.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Texto del mensaje a enviar' },
        title: { type: 'string', description: 'Título del mensaje (opcional)' },
        target: { type: 'string', description: 'Chat ID específico (opcional, usa el default si no se pone)' },
        parse_mode: { type: 'string', enum: ['html', 'markdown', 'markdownv2'], description: 'Formato del mensaje (default: html)' }
      },
      required: ['message']
    }
  },
  {
    name: 'telegram_send_image',
    description: 'Envía una imagen por Telegram (snapshot de cámara, gráfica, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL de la imagen o ruta local (/config/www/...)' },
        caption: { type: 'string', description: 'Texto debajo de la imagen' },
        entity_id: { type: 'string', description: 'Entity ID de cámara para snapshot (ej: camera.salon)' }
      },
      required: ['caption']
    }
  },
  {
    name: 'telegram_get_updates',
    description: 'Lee los últimos mensajes recibidos por el bot de Telegram. Útil para saber si el usuario ha enviado algo por Telegram.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Número de mensajes a obtener (default: 10)' }
      }
    }
  },

  // ─── GitHub / Proyectos ───
  {
    name: 'analyze_github_repos',
    description: 'Analiza los repos del usuario en GitHub. Detecta proyectos compatibles con HA, posibles integraciones, cosas que se pueden conectar. Sugiere sinergias entre proyectos.',
    input_schema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'Username de GitHub del usuario (ej: "padilla585projects")' },
        repo: { type: 'string', description: 'Repo específico a analizar en detalle (opcional). Si no se pone, lista todos.' }
      },
      required: ['username']
    }
  },
  {
    name: 'create_custom_tool',
    description: 'Crea una herramienta/script custom cuando no existe una solución. Genera un script en /config/scripts/jarvis/ que se puede ejecutar. Para automatizaciones, integraciones custom, scrapers, o cualquier cosa que necesites.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del script (sin extensión). Ej: "energy_report", "backup_notify"' },
        language: { type: 'string', enum: ['shell', 'python', 'node'], description: 'Lenguaje del script' },
        code: { type: 'string', description: 'Código del script' },
        description: { type: 'string', description: 'Qué hace este script' },
        schedule: { type: 'string', description: 'Cron schedule si debe ejecutarse periódicamente (ej: "0 8 * * *" = cada día a las 8)' }
      },
      required: ['name', 'language', 'code', 'description']
    }
  },
  {
    name: 'run_custom_tool',
    description: 'Ejecuta un script custom previamente creado en /config/scripts/jarvis/',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre del script a ejecutar' },
        args: { type: 'string', description: 'Argumentos para el script (opcional)' }
      },
      required: ['name']
    }
  },
  {
    name: 'agent_communicate',
    description: 'Comunica con otro agente IA del usuario via webhook/API. Puede enviar mensajes, pedir datos, o coordinar tareas entre agentes.',
    input_schema: {
      type: 'object',
      properties: {
        target_url: { type: 'string', description: 'URL del endpoint del otro agente (webhook, API REST, etc.)' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'Método HTTP' },
        message: { type: 'string', description: 'Mensaje o consulta para el otro agente' },
        data: { type: 'object', description: 'Datos adicionales a enviar (JSON)' },
        auth_header: { type: 'string', description: 'Header de autenticación si lo necesita (Bearer token, API key, etc.)' }
      },
      required: ['target_url', 'method']
    }
  },

  // ─── Crear add-ons ───
  {
    name: 'create_addon',
    description: 'Crea un nuevo add-on de HA. Genera la estructura completa (config.yaml, Dockerfile, run.sh, código). ⚠️ IMPORTANTE: puedes diseñar y preparar el add-on completo, pero NO publicarlo al repositorio sin confirmación explícita de Adrián. El proceso es: construir → mostrar a Adrián → esperar aprobación → publicar.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug del add-on (ej: "energy_monitor", "camera_ai"). Será el nombre de la carpeta.' },
        name: { type: 'string', description: 'Nombre visible del add-on' },
        description: { type: 'string', description: 'Descripción corta (discreta, no revelar todo)' },
        language: { type: 'string', enum: ['node', 'python', 'shell'], description: 'Lenguaje principal del add-on' },
        port: { type: 'number', description: 'Puerto para la interfaz web (si tiene). Default: no web UI.' },
        code: { type: 'string', description: 'Código principal del add-on (server.js, main.py, o run.sh)' },
        dependencies: { type: 'object', description: 'Dependencias: {"npm": ["express"], "apk": ["python3"]} etc.' },
        needs_ingress: { type: 'boolean', description: 'Si necesita panel en el sidebar de HA (default: false)' }
      },
      required: ['slug', 'name', 'description', 'language', 'code']
    }
  },

  // ─── Pensamiento proactivo ───
  {
    name: 'proactive_thought',
    description: 'Registra un pensamiento proactivo o acción pendiente que Jarvis quiere ejecutar. Se enviará al usuario para aprobación via Telegram o se mostrará en el próximo chat.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['suggestion', 'alert', 'action_request', 'optimization', 'creation'], description: 'Tipo de pensamiento' },
        title: { type: 'string', description: 'Título corto del pensamiento' },
        detail: { type: 'string', description: 'Explicación detallada de qué quiere hacer y por qué' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Prioridad' },
        notify_telegram: { type: 'boolean', description: 'Enviar notificación por Telegram (default: true para high/critical)' },
        auto_execute_if_approved: { type: 'string', description: 'Comando/acción a ejecutar si el usuario aprueba (JSON stringified tool call)' }
      },
      required: ['type', 'title', 'detail', 'priority']
    }
  },

  // ─── Base de conocimiento ───
  {
    name: 'update_self',
    description: 'Actualiza el propio conocimiento permanente de Jarvis (self_knowledge) o aplica un patch a su código. Úsalo cuando aprendas algo importante que deba persistir en tu prompt para siempre, o cuando necesites añadir una capacidad nueva a tu código.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add_knowledge', 'update_knowledge', 'remove_knowledge', 'list_knowledge', 'patch_code', 'restart_self'],
          description: 'add_knowledge: añade una sección nueva a tu prompt permanente. update_knowledge: actualiza una sección existente. remove_knowledge: elimina una sección. list_knowledge: muestra todo lo que has escrito. patch_code: modifica tu propio server.js. restart_self: reiníciarte para aplicar cambios.'
        },
        title: { type: 'string', description: 'Título de la sección de conocimiento (ej: "Altavoces de la casa", "Credenciales de servicios", "Rutinas detectadas")' },
        content: { type: 'string', description: 'Contenido de la sección — texto libre, puede incluir instrucciones, datos, configuraciones, etc.' },
        code_patch: { type: 'string', description: 'Código JavaScript a añadir a server.js (para action=patch_code). Describe qué hace y dónde va.' },
        reason: { type: 'string', description: 'Por qué estás añadiendo/modificando esto — para el log y para Adrián' }
      },
      required: ['action']
    }
  },
  {
    name: 'ha_supervisor',
    description: 'Control total del sistema Home Assistant: ver y aplicar actualizaciones (core, OS, supervisor, add-ons, HACS), gestionar add-ons (instalar, desinstalar, iniciar, parar, reiniciar), recargar integraciones, gestionar repos del store, crear backups. USA ESTA TOOL para cualquier gestión del sistema.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'check_updates',       // Ver todas las actualizaciones disponibles
            'update_addon',        // Actualizar un add-on específico
            'update_core',         // Actualizar HA Core
            'update_os',           // Actualizar HA OS
            'update_supervisor',   // Actualizar Supervisor
            'update_all_addons',   // Actualizar todos los add-ons con update disponible
            'restart_addon',       // Reiniciar un add-on
            'start_addon',         // Iniciar un add-on
            'stop_addon',          // Parar un add-on
            'install_addon',       // Instalar un add-on del store
            'uninstall_addon',     // Desinstalar un add-on
            'get_addon_info',      // Info completa de un add-on
            'list_addons',         // Listar todos los add-ons con su estado
            'reload_integration',  // Recargar una integración de HA por dominio
            'reload_all_integrations', // Recargar todas las integraciones caídas
            'get_core_info',       // Info de HA Core (versión, estado)
            'get_os_info',         // Info del OS
            'restart_core',        // Reiniciar HA Core (pide confirmación)
            'get_config_entries',  // Listar todas las integraciones configuradas
            'get_hacs_updates',    // Ver actualizaciones pendientes de HACS
            'update_hacs_repo',    // Actualizar un repositorio/componente de HACS
            'list_repos',          // Listar repos de add-ons configurados en el Supervisor
            'refresh_repo',        // Borrar y re-añadir un repo para forzar detección de nueva versión (fix caché del Supervisor)
            'deploy_update',       // Ciclo completo: refresh_repo + update_addon en una sola llamada. Usar tras github_push.
            'list_backups',        // Listar backups del sistema
            'create_backup'        // Crear un backup completo del sistema
          ]
        },
        addon_slug: { type: 'string', description: 'Slug del add-on (ej: "mosquitto_broker", "zigbee2mqtt", "jarvis_ai_agent")' },
        integration_domain: { type: 'string', description: 'Dominio de la integración (ej: "alexa_media_player", "pvpc_energyhourly", "esphome")' },
        repository_url: { type: 'string', description: 'URL del repositorio del add-on para instalar' },
        repo_url: { type: 'string', description: 'URL del repo a refrescar (refresh_repo/deploy_update). Default: repo de Jarvis.' },
        repo_slug: { type: 'string', description: 'Slug interno del repo en el Supervisor (opcional, para acelerar refresh_repo)' },
        name: { type: 'string', description: 'Nombre para el backup (create_backup)' },
        confirm: { type: 'boolean', description: 'Confirmar acción potencialmente disruptiva (restart_core, update_core, update_os)' }
      },
      required: ['action']
    }
  },
  {
    name: 'knowledge_db',
    description: 'Base de datos de conocimiento de Jarvis. Almacena y consulta todo lo que aprende: conceptos, conexiones, diagramas, configuraciones, protocolos, soluciones. Cada entrada tiene categoría, tags, conexiones con otras entradas, e imágenes opcionales.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'query', 'update', 'delete', 'connect', 'list_categories', 'export'], description: 'Acción a realizar' },
        entry: {
          type: 'object',
          description: 'Entrada de conocimiento (para add/update)',
          properties: {
            title: { type: 'string', description: 'Título del conocimiento' },
            category: { type: 'string', description: 'Categoría: industrial, domotica, networking, programacion, hardware, energia, seguridad, protocolos, integraciones, soluciones, otro' },
            content: { type: 'string', description: 'Contenido principal — explicación, configuración, código, etc.' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags para búsqueda (ej: ["modbus", "siemens", "plc"])' },
            connections: { type: 'array', items: { type: 'string' }, description: 'IDs o títulos de entradas relacionadas' },
            images: { type: 'array', items: { type: 'string' }, description: 'Rutas o URLs de imágenes/diagramas asociados' },
            source: { type: 'string', description: 'Fuente de la información (URL, doc, experiencia, etc.)' },
            importance: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Importancia del conocimiento' }
          }
        },
        query: { type: 'string', description: 'Búsqueda por texto libre (para action=query)' },
        category: { type: 'string', description: 'Filtrar por categoría (para action=query/list_categories)' },
        id: { type: 'string', description: 'ID de la entrada (para update/delete/connect)' },
        connect_to: { type: 'string', description: 'ID de la entrada a conectar (para action=connect)' }
      },
      required: ['action']
    }
  },

  // ─── Red local ───
  {
    name: 'network',
    description: 'Acceso completo a la red local de la casa. Descubre dispositivos, escanea puertos, hace ping, detecta agentes IA en la red, envía peticiones HTTP a cualquier dispositivo local, envía magic packet WoL. Usa esto para explorar la red, hablar con APIs de dispositivos locales o despertar PCs.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['arp_table', 'scan_subnet', 'ping', 'port_scan', 'http_request', 'discover_agents', 'wol'],
          description: 'arp_table: dispositivos en la red (tabla ARP) | scan_subnet: ping sweep de la subred | ping: probar un host | port_scan: puertos abiertos de un host | http_request: llamar a la API de un dispositivo local | discover_agents: detectar agentes IA (Ollama, LM Studio, otro Jarvis...) | wol: Wake-on-LAN'
        },
        host: { type: 'string', description: 'IP o hostname del dispositivo' },
        subnet: { type: 'string', description: 'Prefijo de subred a escanear (ej: "192.168.1"). Si no se indica, se detecta automáticamente.' },
        ports: { type: 'array', items: { type: 'number' }, description: 'Puertos a escanear en port_scan (ej: [80, 443, 8080, 22])' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'Método HTTP para http_request (default: GET)' },
        url: { type: 'string', description: 'URL completa para http_request (ej: "http://192.168.1.50:8080/api/status")' },
        body: { type: 'object', description: 'Body JSON para http_request' },
        headers: { type: 'object', description: 'Headers HTTP adicionales para http_request' },
        mac: { type: 'string', description: 'MAC address para WoL (formato: AA:BB:CC:DD:EE:FF)' }
      },
      required: ['action']
    }
  },

  // ─── Archivos del PC del usuario ───
  {
    name: 'local_file',
    description: 'Lee y navega los archivos del ordenador del usuario (el PC desde el que está hablando con Jarvis). Requiere que el usuario haya hecho clic en "📁 Conectar PC" en la interfaz. Permite leer documentos, configs, logs y cualquier archivo de su máquina.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'list', 'search'],
          description: 'read: lee el contenido de un archivo | list: lista directorio | search: busca archivos por nombre'
        },
        path: { type: 'string', description: 'Ruta relativa dentro de la carpeta conectada. Usa "." para la raíz. Ej: "documentos/config.yaml"' },
        query: { type: 'string', description: 'Texto a buscar en los nombres de archivos (para action=search)' },
        max_depth: { type: 'number', description: 'Profundidad máxima para list (default: 2)' }
      },
      required: ['action']
    }
  },

  // ─── Chat con otros agentes IA ───
  {
    name: 'agent_chat',
    description: 'Comunícate con otros agentes IA descubiertos en la red: Ollama, LM Studio, LocalAI, otro Jarvis, o cualquier API OpenAI-compatible. Primero usa network→discover_agents para encontrarlos. Puedes consultar modelos especializados o colaborar con otro agente.',
    input_schema: {
      type: 'object',
      properties: {
        agent_url: { type: 'string', description: 'URL base del agente (ej: "http://192.168.1.50:11434")' },
        agent_type: {
          type: 'string',
          enum: ['ollama', 'openai_compatible', 'jarvis', 'custom'],
          description: 'ollama: protocolo Ollama | openai_compatible: LM Studio, LocalAI, etc. | jarvis: otro Jarvis | custom: intentar openai compatible'
        },
        model: { type: 'string', description: 'Modelo a usar en el agente (ej: "llama3.2", "mistral", "phi3")' },
        message: { type: 'string', description: 'Mensaje a enviar al agente' },
        system_prompt: { type: 'string', description: 'Prompt de sistema (opcional)' }
      },
      required: ['agent_url', 'agent_type', 'message']
    }
  },

  // ─── GitHub self-evolution ───
  {
    name: 'github_push',
    description: 'Lee o modifica archivos en el repo de GitHub de Jarvis via API. Permite a Jarvis evolucionar su propio código: añadir tools, corregir bugs, mejorar la UI. ⚠️ IMPORTANTE: write_file hace un commit real al repo público — REQUIERE confirmación explícita de Adrián antes de ejecutar. Puedes preparar y mostrar el contenido, pero NO hacer push sin permiso. Después de un push autorizado, usar ha_supervisor→update_addon para aplicar los cambios.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read_file', 'write_file', 'list_files'],
          description: 'read_file: lee un archivo del repo | write_file: crea o actualiza un archivo | list_files: lista archivos de una carpeta'
        },
        path: { type: 'string', description: 'Ruta dentro del repo (ej: "jarvis/server.js", "jarvis/index.html", "jarvis/config.yaml")' },
        content: { type: 'string', description: 'Contenido completo del archivo (para action=write_file)' },
        commit_message: { type: 'string', description: 'Mensaje del commit (para action=write_file). Descriptivo y en inglés.' },
        adrian_confirmed: { type: 'boolean', description: 'REQUERIDO para write_file. Solo poner true si Adrián ha dicho explícitamente "sí, publícalo" o similar en este turno de conversación. Sin este campo el servidor bloquea la acción.' }
      },
      required: ['action', 'path']
    }
  },

  // ─── Rollback ───
  {
    name: 'rollback',
    description: 'Restaura un archivo a una versión anterior del backup automático. Muestra los backups disponibles o restaura uno concreto. REQUIERE confirmación de Adrián antes de restaurar.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'restore'], description: 'list: muestra backups disponibles | restore: restaura un backup concreto' },
        filepath: { type: 'string', description: 'Ruta del archivo original (ej: /config/automations.yaml)' },
        backup_name: { type: 'string', description: 'Nombre del archivo de backup a restaurar (obtenido con action=list)' },
        adrian_confirmed: { type: 'boolean', description: 'REQUERIDO para restore. Adrián debe confirmar explícitamente.' }
      },
      required: ['action', 'filepath']
    }
  },

  // ─── Análisis de patrones manual ───
  {
    name: 'analyze_patterns',
    description: 'Muestra las rutinas detectadas automáticamente por Jarvis, o fuerza un nuevo análisis de patrones de uso del hogar. Las sugerencias resultantes requieren aprobación de Adrián para ejecutarse.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show_routines', 'force_analysis'], description: 'show_routines: muestra rutinas detectadas | force_analysis: lanza análisis ahora' }
      },
      required: ['action']
    }
  },

  // ─── Voz bidireccional Alexa ───
  {
    name: 'alexa_bidirectional',
    description: 'Configura o usa la integración de voz bidireccional con Alexa. setup: crea la automatización en HA para que Alexa escuche comandos dirigidos a Jarvis y los enrute aquí. check: ve si hay comandos de voz pendientes. respond: responde por TTS al Echo que hizo la pregunta.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['setup', 'check', 'respond', 'status'], description: 'setup: configura la automatización en HA | check: comandos pendientes | respond: responde por TTS | status: estado de la integración' },
        message: { type: 'string', description: 'Texto de respuesta (para respond)' },
        target_echo: { type: 'string', description: 'Entity ID del Echo que hizo la pregunta (para respond)' }
      },
      required: ['action']
    }
  },

  // ─── Multiusuario ───
  {
    name: 'manage_users',
    description: 'Gestiona perfiles de usuario. Solo Adrián puede añadir, eliminar o cambiar permisos. Los usuarios nuevos arrancan con permisos de solo lectura.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'remove', 'set_permissions', 'get_profile'], description: 'list: ver usuarios | add: añadir | remove: eliminar | set_permissions: cambiar permisos | get_profile: ver perfil' },
        username: { type: 'string', description: 'Nombre del usuario' },
        display_name: { type: 'string', description: 'Nombre visible (para add)' },
        permissions: { type: 'string', enum: ['read', 'write', 'admin'], description: 'Nivel de permisos (para set_permissions). Solo Adrián puede asignar admin.' },
        preferences: { type: 'object', description: 'Preferencias del usuario (idioma, temperatura, etc.)' },
        adrian_confirmed: { type: 'boolean', description: 'REQUERIDO para add/remove/set_permissions.' }
      },
      required: ['action']
    }
  },

  // ─── Generación de imágenes ───
  {
    name: 'generate_image',
    description: 'Genera una imagen con DALL-E 3 (OpenAI). Úsalo para renders de habitaciones, conceptos de diseño, planos artísticos, visualizaciones de cambios o cualquier imagen que ayude a Adrián a ver cómo quedaría algo. Guarda en /share/jarvis/images/ y /local/jarvis/ para Lovelace. Devuelve lovelace_url — inclúyela en tu respuesta como ![descripción](url) para que se muestre en el chat.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Descripción detallada. Para interiores: estilo, colores, muebles, iluminación, perspectiva.' },
        filename: { type: 'string', description: 'Nombre del archivo sin extensión (ej: "plano_planta0"). Si no se especifica, se genera automáticamente.' },
        size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'], description: '1536x1024 para planos/panorámicas. 1024x1536 para verticales/retratos. Default: 1024x1024' },
        quality: { type: 'string', enum: ['standard', 'hd'], description: 'hd: más detallado y lento. Default: standard' }
      },
      required: ['prompt']
    }
  },

  // ─── Búsqueda web nativa de GPT-4.1 ───
  {
    name: 'web_search_native',
    description: 'Búsqueda web NATIVA de GPT-4.1 (no DuckDuckGo). Hace que GPT busque en internet con su tool web_search_preview integrado, leyendo páginas en tiempo real con citaciones. Mucho mejor que web_search para preguntas que requieren información actual, comparativas, productos, precios, noticias o documentación reciente. Devuelve respuesta sintetizada con fuentes. Más caro que web_search pero mucho más preciso.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Pregunta o tema a investigar. Sé específico — GPT navega y sintetiza.' },
        context: { type: 'string', description: 'Contexto extra: por qué lo buscas, qué resultado esperas. Mejora la calidad.' }
      },
      required: ['query']
    }
  },

  // ─── Edición de imágenes (DALL-E edit + vision) ───
  {
    name: 'image_edit',
    description: 'Edita una imagen existente con DALL-E (inpainting). Recibe la ruta del archivo de imagen original y un prompt describiendo el cambio. Opcionalmente acepta una máscara PNG (zonas transparentes = áreas a editar). Devuelve la ruta del archivo nuevo en /share/jarvis/images/. Útil para retocar fotos, modificar planos, cambiar elementos visuales. Para análisis visual sin editar, usa read_file sobre la imagen (la visión está integrada en el chat).',
    input_schema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Ruta absoluta a la imagen origen (PNG). Debe ser cuadrada para mejores resultados.' },
        prompt: { type: 'string', description: 'Descripción de qué cambiar. Sé específico sobre la zona y el resultado deseado.' },
        mask_path: { type: 'string', description: 'Opcional: ruta a PNG de máscara (transparente = editar, opaco = mantener). Si no se da, edita toda la imagen.' },
        size: { type: 'string', enum: ['256x256', '512x512', '1024x1024'], description: 'Default: 1024x1024' }
      },
      required: ['image_path', 'prompt']
    }
  },

  // ─── Workspace de desarrollo (sandbox + iteración) ───
  {
    name: 'dev_workspace',
    description: 'Workspace privado para prototipar código, ejecutar pruebas, iterar sobre archivos sin afectar /config ni la instalación real. Usa /data/workspace/ como sandbox. Acciones: create (nuevo workspace), write (archivo), read (archivo), list (todos los archivos), exec (ejecuta python/bash/node sobre los archivos), test (ejecuta tests), apply (promociona el workspace a /config tras éxito), discard (descarta el workspace). Úsalo SIEMPRE antes de tocar /config en cambios complejos.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'write', 'read', 'list', 'exec', 'test', 'apply', 'discard'], description: 'Operación a realizar' },
        workspace_id: { type: 'string', description: 'ID del workspace (string corto, ej. "automation-fix"). Required excepto en list.' },
        file: { type: 'string', description: 'Ruta relativa dentro del workspace (ej. "test.yaml", "src/main.js")' },
        content: { type: 'string', description: 'Contenido a escribir (para action=write)' },
        command: { type: 'string', description: 'Comando a ejecutar (para action=exec, ej. "node test.js", "python validate.py")' },
        target_path: { type: 'string', description: 'Ruta destino al hacer apply (ej. "/config/automations.yaml"). Required para apply.' }
      },
      required: ['action']
    }
  },

  // ─── Plano SVG interactivo ───
  {
    name: 'render_floorplan',
    description: 'Genera un plano SVG interactivo de la instalación basado en las áreas de Home Assistant. Muestra habitaciones con dispositivos activos, luces encendidas y presencia. El SVG se puede inyectar en el chat con un bloque ```html-render. Úsalo cuando Adrián quiera ver el estado de la casa visualmente.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['render', 'get_layout', 'save_layout'], description: 'render: genera y devuelve el SVG. get_layout: devuelve el layout guardado. save_layout: guarda posiciones personalizadas.' },
        include_entities: { type: 'boolean', description: 'Mostrar puntos de dispositivos activos. Default: true' },
        layout: { type: 'object', description: 'Para save_layout: {area_id: {col, row}} — posición en la cuadrícula.' }
      },
      required: ['action']
    }
  },

  // ─── Modificar interfaz ───
  {
    name: 'update_ui',
    description: 'Inyecta HTML, SVG o CSS personalizado directamente en el chat. Úsalo para crear visualizaciones, widgets interactivos, dashboards customizados o componentes visuales que no caben en texto. El HTML se renderiza con un bloque ```html-render en tu respuesta.',
    input_schema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Código HTML/SVG a renderizar. Puede incluir estilos inline. Se inyecta con innerHTML.' },
        title: { type: 'string', description: 'Título descriptivo del componente.' },
        save_as: { type: 'string', description: 'Nombre de archivo para guardar en /data/ui_components/ y poder reutilizarlo.' }
      },
      required: ['html']
    }
  },

  // ─── NEXUS: gestión dinámica de expertos y módulos ───
  {
    name: 'nexus_manage',
    description: 'Gestiona el sistema NEXUS: crea/edita/elimina expertos y módulos de prompt dinámicamente. Los cambios se persisten y sobreviven reinicios. Usa esto cuando detectes que necesitas un especialista nuevo (energía, zigbee, multimedia...) o quieras ajustar uno existente.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create_expert', 'edit_expert', 'delete_expert', 'create_module', 'edit_module', 'delete_module', 'get_health'], description: 'Acción a realizar.' },
        name: { type: 'string', description: 'Nombre del experto o módulo (slug sin espacios, ej: energia, zigbee, multimedia).' },
        config: {
          type: 'object',
          description: 'Config del experto: { model: "MODEL"|"BG_MODEL", maxTokens: number, maxIter: number, modules: ["base","..."], label: "Nombre visible", keywords: ["palabra1","palabra2"] }. keywords se usan para routing regex automático.',
          properties: {
            model: { type: 'string' },
            maxTokens: { type: 'number' },
            maxIter: { type: 'number' },
            modules: { type: 'array', items: { type: 'string' } },
            label: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } }
          }
        },
        content: { type: 'string', description: 'Contenido del módulo de prompt (para create_module/edit_module).' }
      },
      required: ['action']
    }
  },

  // ─── Ejecución de código y comandos ───
  {
    name: 'exec_command',
    description: 'Ejecuta comandos bash, scripts Python o código Node.js directamente en el servidor. MÁXIMA POTENCIA: instala paquetes (pip/apk), procesa archivos, genera imágenes con Pillow/matplotlib, analiza datos con pandas, crea cualquier cosa. Usa python3 para ciencia de datos/imágenes, bash para gestión del sistema, node para JavaScript. Como el Bash tool de Claude Code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Código o comando a ejecutar' },
        language: { type: 'string', enum: ['bash', 'python3', 'node'], description: 'bash (default): comandos del sistema | python3: scripts Python | node: JavaScript' },
        timeout: { type: 'number', description: 'Timeout en segundos (default: 30, max: 120)' },
        working_dir: { type: 'string', description: 'Directorio de trabajo (default: /data)' },
        install_packages: { type: 'array', items: { type: 'string' }, description: 'Paquetes pip o apk a instalar antes de ejecutar (ej: ["pillow","matplotlib"] o ["ffmpeg"])' }
      },
      required: ['command']
    }
  },

  // ─── Mapa 3D de la casa ───
  {
    name: 'house_3d_map',
    description: 'Crea y gestiona un mapa 3D interactivo de la casa con Three.js. El mapa se sirve en /3d-map y se puede embeber en Lovelace como tarjeta iframe. Muestra habitaciones con colores, luces activas, presencia y dispositivos en tiempo real. Primero usa setup_rooms para definir las habitaciones, luego el mapa aparece automáticamente.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['setup_rooms', 'get_config', 'get_lovelace_card', 'reset'], description: 'setup_rooms: define/actualiza las habitaciones | get_config: ver config actual | get_lovelace_card: YAML para Lovelace | reset: borrar config' },
        rooms: {
          type: 'array',
          description: 'Lista de habitaciones (para setup_rooms). Coordenadas en metros desde la esquina superior-izquierda de la planta.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'ID único (ej: salon, dormitorio_1, cocina)' },
              name: { type: 'string', description: 'Nombre visible en el mapa' },
              x: { type: 'number', description: 'Posición X en metros' },
              y: { type: 'number', description: 'Posición Y en metros (profundidad)' },
              width: { type: 'number', description: 'Ancho en metros' },
              depth: { type: 'number', description: 'Profundidad en metros' },
              height: { type: 'number', description: 'Altura del techo en metros (default: 2.5)' },
              color: { type: 'string', description: 'Color hex del suelo (ej: #1a2744). Opcional.' },
              floor: { type: 'number', description: 'Número de planta: 0=baja, 1=primera, etc. (default: 0)' },
              entities: { type: 'array', items: { type: 'string' }, description: 'entity_ids de HA en esta habitación (para mostrar estado en tiempo real)' }
            },
            required: ['id', 'name', 'width', 'depth']
          }
        }
      },
      required: ['action']
    }
  },

  // ─── Emergencias autónomas ───
  {
    name: 'emergency_config',
    description: 'Configura o consulta el modo de emergencias autónomas. Jarvis puede actuar solo ante eventos de seguridad física (humo, CO, inundación, corte de luz) con acciones pre-autorizadas por Adrián.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get_config', 'set_triggers', 'set_actions', 'enable', 'disable', 'test'], description: 'get_config: ver config actual | set_triggers: definir qué entidades disparan emergencia | set_actions: definir acciones pre-autorizadas | enable/disable: activar/desactivar | test: simular sin ejecutar' },
        triggers: { type: 'array', items: { type: 'object' }, description: 'Lista de triggers: [{entity_id, state, description}]' },
        actions: { type: 'array', items: { type: 'object' }, description: 'Acciones pre-autorizadas: [{domain, service, entity_id, description}]' },
        adrian_confirmed: { type: 'boolean', description: 'REQUERIDO para set_triggers, set_actions, enable.' }
      },
      required: ['action']
    }
  },

  // ─── Editar automatización ───
  {
    name: 'edit_automation',
    description: 'Edita una automatización existente en /config/automations.yaml buscándola por alias o id. Reemplaza la entrada completa con el nuevo YAML proporcionado y recarga las automatizaciones.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Alias o id de la automatización a editar' },
        yaml_content: { type: 'string', description: 'Nuevo YAML completo para esta automatización (un único objeto, sin el guión de lista)' }
      },
      required: ['identifier', 'yaml_content']
    }
  },

  // ─── Eliminar automatización ───
  {
    name: 'delete_automation',
    description: 'Elimina una automatización de /config/automations.yaml buscándola por alias o id. Hace backup automático antes de borrar y recarga las automatizaciones.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Alias o id de la automatización a eliminar' }
      },
      required: ['identifier']
    }
  },

  // ─── Scripts ───
  {
    name: 'edit_script',
    description: 'Edita un script existente en /config/scripts.yaml buscándolo por su ID (clave raíz). Reemplaza el bloque completo con el nuevo YAML. Usa formato action: (service call), NUNCA type: (device action). Hace backup automático.',
    input_schema: {
      type: 'object',
      properties: {
        script_id: { type: 'string', description: 'ID del script (clave raíz en scripts.yaml, ej: luz_escalera)' },
        yaml_content: { type: 'string', description: 'Nuevo YAML del script (solo el contenido bajo la clave, sin la clave raíz)' }
      },
      required: ['script_id', 'yaml_content']
    }
  },
  {
    name: 'delete_script',
    description: 'Elimina un script de /config/scripts.yaml por su ID. Hace backup automático antes de borrar y recarga scripts.',
    input_schema: {
      type: 'object',
      properties: {
        script_id: { type: 'string', description: 'ID del script a eliminar (clave raíz en scripts.yaml)' }
      },
      required: ['script_id']
    }
  },

  // ─── MQTT ───
  {
    name: 'mqtt_publish',
    description: 'Publica un mensaje MQTT via HA. Útil para Zigbee2MQTT, Tasmota, ESPHome y cualquier dispositivo MQTT.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic MQTT (ej: zigbee2mqtt/bridge/config/permit_join, cmnd/tasmota/POWER)' },
        payload: { type: 'string', description: 'Payload del mensaje (texto o JSON stringified)' },
        retain: { type: 'boolean', description: 'Si el mensaje debe ser retenido (default: false)' }
      },
      required: ['topic', 'payload']
    }
  },

  // ─── Zigbee2MQTT ───
  {
    name: 'zigbee_manage',
    description: 'Gestiona Zigbee2MQTT: emparejar dispositivos, renombrar, ver mapa de red, estado del bridge, OTA updates.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['permit_join', 'devices', 'network_map', 'rename', 'remove', 'ota_check', 'ota_update', 'bridge_info', 'restart'], description: 'Acción a realizar' },
        device: { type: 'string', description: 'Nombre o IEEE del dispositivo (para rename, remove, ota_update)' },
        new_name: { type: 'string', description: 'Nuevo nombre (solo para rename)' },
        duration: { type: 'number', description: 'Duración en segundos para permit_join (default: 120)' }
      },
      required: ['action']
    }
  },

  // ─── Renderizar template Jinja2 ───
  {
    name: 'template_render',
    description: 'Renderiza un template Jinja2 usando la API de Home Assistant. Útil para probar expresiones de templates, calcular valores dinámicos o depurar condiciones antes de usarlas en automatizaciones.',
    input_schema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Template Jinja2 a renderizar, por ejemplo: "{{ states(\'sensor.temperatura\') }}"' }
      },
      required: ['template']
    }
  },

  // ─── Puntuación de instalación ───
  {
    name: 'score_installation',
    description: 'Evalúa la calidad de la instalación de Home Assistant en varias dimensiones y devuelve una puntuación de 0 a 100 junto con recomendaciones específicas de mejora.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },

  // ─── Auditoría de Lovelace ───
  {
    name: 'review_dashboard',
    description: 'Auditoría profesional de tu dashboard Lovelace. Analiza layout, performance, UX, estética y recomienda cambios como lo haría un diseñador profesional. Revisa todos los dashboards o uno específico.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['analyze_all', 'analyze_one', 'generate_improvement_plan'], description: 'analyze_all: todos los dashboards | analyze_one: un dashboard específico | generate_improvement_plan: plan paso a paso de mejoras' },
        dashboard_id: { type: 'string', description: 'ID del dashboard a analizar (solo para analyze_one)' },
        focus: { type: 'string', enum: ['layout', 'performance', 'ux', 'aesthetics', 'completeness', 'all'], description: 'Área de enfoque. all analiza todo.' }
      },
      required: ['action']
    }
  },

  // ─── Simulación de automatizaciones ───
  {
    name: 'simulate_automation',
    description: 'Simula una automatización sin ejecutarla. Analiza sus triggers, condiciones y acciones y describe paso a paso qué pasaría si se disparara ahora mismo.',
    input_schema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'Alias o id de la automatización a simular'
        }
      },
      required: ['identifier']
    }
  },

  // ─── Generación de imágenes Gemini ───
  {
    name: 'generate_image_gemini',
    description: 'Genera imágenes con Google Gemini Imagen 4 (alta calidad). Ideal para planos de casas, renders de habitaciones, visualizaciones de domótica, diagramas arquitectónicos. Requiere GEMINI_API_KEY configurada. Guarda el resultado en /share/jarvis/images/ y devuelve la URL local.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Descripción detallada de la imagen a generar. Para planos: incluir distribución, estilo (arquitectónico, acuarela, minimalista...), colores, qué elementos mostrar.'
        },
        filename: {
          type: 'string',
          description: 'Nombre del archivo sin extensión (ej: "plano_casa"). Se guarda como .png en /share/jarvis/images/'
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '9:16', '16:9', '4:3', '3:4'],
          description: 'Proporción de la imagen. Default: 1:1. Para planos verticales usa 3:4 o 9:16.'
        },
        model: {
          type: 'string',
          enum: ['imagen-4', 'gemini-flash'],
          description: 'imagen-4: máxima calidad (Imagen 4, auto-fallback a versiones anteriores). gemini-flash: más rápido. Default: imagen-4'
        }
      },
      required: ['prompt', 'filename']
    }
  },

  // ─── Backup/Restore ───
  {
    name: 'backup_restore',
    description: 'Gestiona backups (snapshots) de Home Assistant: listar, crear, info, restaurar, eliminar. Usa la API del Supervisor.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'info', 'restore', 'delete'], description: 'list: listar backups. create: crear nuevo. info: detalles de uno. restore: restaurar. delete: eliminar.' },
        slug: { type: 'string', description: 'Slug del backup (para info, restore, delete)' },
        name: { type: 'string', description: 'Nombre del backup (para create). Default: "Jarvis backup FECHA"' },
        partial: { type: 'boolean', description: 'true para backup parcial (solo config), false para completo. Default: false' }
      },
      required: ['action']
    }
  },

  // ─── Notificación unificada ───
  {
    name: 'notify_all',
    description: 'Envía notificación por múltiples canales simultáneamente: Telegram, push HA (companion app), y/o TTS por altavoces. Ideal para alertas importantes.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Mensaje a enviar' },
        title: { type: 'string', description: 'Título (opcional, para push)' },
        channels: { type: 'array', items: { type: 'string', enum: ['telegram', 'push', 'tts'] }, description: 'Canales. Default: ["telegram", "push"]' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], description: 'Prioridad. critical: TTS inmediato + notificación persistente' },
        tts_target: { type: 'string', description: 'Entity ID del media_player para TTS. Default: todos los media_player disponibles.' }
      },
      required: ['message']
    }
  },

  // ─── Energy dashboard ───
  {
    name: 'energy_query',
    description: 'Consulta datos energéticos de Home Assistant: consumo actual, historial, producción solar, coste estimado. Usa la API de estadísticas de HA.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['current', 'daily', 'weekly', 'monthly', 'sensors', 'cost'], description: 'current: consumo ahora. daily/weekly/monthly: historial. sensors: listar sensores energéticos. cost: estimación de coste.' },
        period: { type: 'string', description: 'Periodo para daily/weekly/monthly. Formato ISO o "today", "yesterday", "this_week", "this_month"' }
      },
      required: ['action']
    }
  },

  // ─── Matter / ZHA management ───
  {
    name: 'zha_matter_manage',
    description: 'Gestiona dispositivos ZHA (Zigbee Home Automation) y Matter/Thread. Listar dispositivos, info, emparejar, eliminar, reconfigurar. Funciona con la integración ZHA o Matter de HA.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list_zha', 'list_matter', 'device_info', 'permit_join', 'remove', 'reconfigure', 'get_groups', 'get_network'], description: 'Acción a realizar' },
        ieee: { type: 'string', description: 'IEEE address del dispositivo ZHA (para device_info, remove, reconfigure)' },
        device_id: { type: 'string', description: 'Device ID de Matter (para device_info, remove)' },
        duration: { type: 'number', description: 'Duración en segundos para permit_join (default: 60)' }
      },
      required: ['action']
    }
  },

  // ─── System Info ───
  {
    name: 'system_info',
    description: 'Información del sistema: hardware, host, red, DNS, almacenamiento. Usa la API del Supervisor para obtener datos del sistema.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['host', 'hardware', 'network', 'dns', 'os', 'multicast', 'resolution'], description: 'host: info del host. hardware: CPU, RAM, discos. network: interfaces. dns: resolución DNS. os: versión OS. resolution: centro de resolución.' }
      },
      required: ['action']
    }
  },

  // ─── ESPHome management ───
  {
    name: 'esphome_manage',
    description: 'Gestiona dispositivos ESPHome: listar, ver config, compilar, flashear, logs, reiniciar. Requiere el add-on ESPHome instalado.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'config', 'compile', 'install', 'logs', 'restart', 'addon_info', 'validate'], description: 'list: dispositivos. config: ver YAML de un dispositivo. compile: compilar firmware. install: flashear OTA. logs: ver logs. restart: reiniciar add-on. addon_info: info del add-on. validate: validar config.' },
        device: { type: 'string', description: 'Nombre del dispositivo (sin extensión .yaml). Ej: salon_sensor, cocina_led' }
      },
      required: ['action']
    }
  },

  // ─── Panel visual ───
  {
    name: 'show_house_status',
    description: 'Muestra un panel visual en el chat con el estado de la casa: luces (on/off/brillo), temperaturas por habitación, climatización, persianas, presencia y media en reproducción. Úsala cuando el usuario pida el estado de la casa, resumen de la casa, o /estado.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  // ─── Inteligencia: clima, presencia, anomalías ───
  {
    name: 'climate_optimize',
    description: 'Analiza y optimiza la climatización del hogar. Acciones: analyze (analiza uso actual y desperdicio HVAC), suggest (genera sugerencias de automatizaciones de ahorro), schedule (propone horarios óptimos basados en ocupación y PVPC), efficiency (calcula eficiencia: gasto vs confort).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['analyze', 'suggest', 'schedule', 'efficiency'], description: 'Tipo de análisis' },
        zone: { type: 'string', description: 'Zona/habitación a analizar (opcional, sin especificar = toda la casa)' },
        period_hours: { type: 'number', description: 'Horas de historial a analizar (default: 48)' }
      },
      required: ['action']
    }
  },
  {
    name: 'presence_predict',
    description: 'Analiza patrones de presencia y predice comportamiento. Acciones: analyze (analiza historial de person.*/device_tracker.* para detectar rutinas), predict (predice próxima llegada/salida basándose en patrones), occupancy (mapa de ocupación actual por habitación usando sensores de movimiento), routines (detecta rutinas diarias/semanales).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['analyze', 'predict', 'occupancy', 'routines'], description: 'Tipo de análisis' },
        person: { type: 'string', description: 'Entity_id de la persona (default: person.adrian)' },
        days: { type: 'number', description: 'Días de historial a analizar (default: 7)' }
      },
      required: ['action']
    }
  },
  {
    name: 'anomaly_detect',
    description: 'Detecta anomalías en dispositivos y sensores comparando con línea base histórica. Acciones: scan (escanea todos los dispositivos buscando anomalías), baseline (calcula línea base de un sensor/dispositivo), check (comprueba un dispositivo específico contra su línea base), report (genera informe de salud de la instalación).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'baseline', 'check', 'report'], description: 'Tipo de análisis' },
        entity_id: { type: 'string', description: 'Entity_id a analizar (para baseline/check)' },
        threshold: { type: 'number', description: 'Factor de desviación para considerar anomalía (default: 2.0 = 2 sigma)' }
      },
      required: ['action']
    }
  }
];

// Formato OpenAI (convertido desde formato Anthropic)
const openAITools = tools.map(t => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema || { type: 'object', properties: {} }
  }
}));

module.exports = { tools, openAITools };
