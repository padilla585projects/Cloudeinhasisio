'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// INFRAGUARD — Watchdog de servicios de Home Assistant
//
// Complementa a NETGUARD (que vigila DNS/red a nivel de OS, sin depender de IA).
// INFRAGUARD vigila la capa de servicios de HA:
//   · Add-ons crasheados (estado "error" en Supervisor) → reinicio automático
//   · Integraciones con entidad de salud conocida (Zigbee2MQTT, etc.) → reinicio
//
// Guardarraíles: doble confirmación antes de actuar, cooldown por servicio,
// tope diario de reinicios, lista de slugs que NUNCA se tocan.
// Alerta por Telegram + pending_thoughts en cada acción.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haGet, supervisorGet, supervisorPost } = require('../utils/ha-api');
const { notify: notifyChannel } = require('../utils/notify');
const C = require('../utils/constants');

const STATE_FILE   = path.join(C.DATA_DIR, 'infraguard_state.json');
const THOUGHTS_FILE = path.join(C.DATA_DIR, 'pending_thoughts.json');

// Guardarraíles
const COOLDOWN_MS      = 20 * 60_000;  // 20 min de espera entre reinicios del mismo add-on
const MAX_ACTIONS_DAY  = 3;            // tope diario de reinicios por add-on
const CONFIRM_LOOPS    = 2;            // fallos consecutivos antes de actuar

// ── Conectividad del anfitrión de HA ────────────────────────────────────────
// POR QUE EXISTE (incidente del 01-10-2026): el backup nocturno de Proxmox pausa
// la VM de HA unos 15 s para arrancar la copia. Esa noche, a las 03:29 —dos
// minutos después— HA OS se quedó con la red medio rota: el puerto 80 de salida
// colgado, el chequeo de conectividad de NetworkManager fallando, y el
// Supervisor convencido de que "no hay internet", BLOQUEANDO las actualizaciones
// ("blocked from execution, no host internet connection"). Además seis enchufes
// y varios ESPHome se quedaron unavailable. Nadie avisó. Un reinicio del
// anfitrión lo arregló todo de golpe.
//
// La firma del fallo es muy concreta y no se confunde con una caída real:
//     host_internet === false  &&  supervisor_internet === true
// "El Supervisor sale a internet, pero el sistema jura que no". Ante una caída
// de verdad de la fibra, los DOS serían false y aquí no se hace nada.
const HOST_FAIL_MIN_MS      = 15 * 60_000;   // el fallo tiene que durar 15 min
const HOST_MAX_REBOOTS_DAY  = 1;             // si tras reiniciar vuelve, avisa y NO insiste
// Ventana de los backups de Proxmox (hora LOCAL de HA). No se reinicia dentro:
// reiniciar la VM a mitad de su propia copia sería peor que el problema. Las
// copias arrancan a las 03:00; la de HA (VM 101) acabó a las 04:12 el 01-10.
// Margen hasta las 05:00.
const BACKUP_WINDOW = { desdeMin: 3 * 60, hastaMin: 5 * 60 };

// Add-ons que NUNCA reiniciamos (infraestructura crítica del sistema)
const NEVER_RESTART = new Set([
  'hassio_supervisor', 'hassio_observer', 'hassio_multicast',
  'hassio_audio', 'hassio_dns', 'hassio_cli',
  'core_ssh', 'core_configurator',
  'jarvis_ai_agent',                    // no suicidarse
]);

// ── Checks por entidad de HA ────────────────────────────────────────────────
// Si la entidad lleva CONFIRM_LOOPS ciclos en badStates → reiniciar el add-on
// cuyo slug coincida con addonPattern.
const ENTITY_CHECKS = [
  {
    id: 'zigbee2mqtt_bridge',
    name: 'Puente Zigbee2MQTT',
    entity: 'binary_sensor.zigbee2mqtt_bridge_connection_state',
    badStates: ['off', 'unavailable', 'unknown'],
    addonPattern: /zigbee2mqtt/i,
  },
  {
    id: 'deconz_bridge',
    name: 'Puente deCONZ/Phoscon',
    entity: 'binary_sensor.deconz_connectivity',
    badStates: ['off', 'unavailable', 'unknown'],
    addonPattern: /deconz/i,
    optional: true,
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function recordThought(t) {
  try {
    const thoughts = loadJSON(THOUGHTS_FILE, []);
    thoughts.push({
      id: Date.now(), type: 'infraguard', status: 'pending',
      created: new Date().toISOString(), ...t,
    });
    saveJSON(THOUGHTS_FILE, thoughts);
  } catch {}
}

async function notify(msg) {
  await notifyChannel(msg, { title: 'Jarvis — Infraestructura', source: 'infraguard' });
}

// Lista todos los add-ons vía Supervisor
// NOTA: el prefijo /hassio/ es el que usa HA Core/frontend como proxy — un add-on
// llamando directamente al socket del Supervisor debe omitirlo (/addons, no
// /hassio/addons). Con el prefijo de más, el Supervisor devolvía 403 siempre,
// pareciendo un problema de permisos cuando en realidad era una ruta inexistente.
async function getAddons() {
  try {
    const r = await supervisorGet('/addons');
    return r?.data?.addons || [];
  } catch (e) {
    console.log(`[infraguard] No pude consultar add-ons: ${e.message}`);
    return [];
  }
}

// Reinicia un add-on por slug
async function restartAddon(slug) {
  await supervisorPost(`/addons/${slug}/restart`);
}

// Minuto del día en la zona horaria de HA (el contenedor puede ir en UTC).
function minutoDelDia(fecha, zona) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: zona, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(fecha);
  const h = Number(p.find(x => x.type === 'hour').value) % 24;
  const m = Number(p.find(x => x.type === 'minute').value);
  return h * 60 + m;
}

// Vigila el falso negativo de conectividad del anfitrión y, con guardarraíles,
// reinicia el host. `deps` existe para poder probarlo sin tocar el Supervisor.
async function checkHostInternet(st, deps = {}) {
  const getNet  = deps.getNet  || (async () => (await supervisorGet('/network/info')).data);
  const reboot  = deps.reboot  || (async () => supervisorPost('/host/reboot'));
  const getZona = deps.getZona || (async () => {
    try { return (await haGet('/config')).time_zone || 'Europe/Madrid'; } catch { return 'Europe/Madrid'; }
  });
  const ahora   = deps.now ? deps.now() : Date.now();
  const avisar  = deps.notify || notify;
  const anotar  = deps.recordThought || recordThought;
  const guardar = deps.save || (() => saveJSON(STATE_FILE, st));

  st.host = st.host || { since: 0, rebootsToday: 0, lastRebootAt: 0, capNotified: false, pending: false };
  const h = st.host;

  let net;
  try { net = await getNet(); }
  catch (e) { console.log(`[infraguard] no pude leer /network/info: ${e.message}`); return 'sin_datos'; }

  const falsoNegativo = net?.host_internet === false && net?.supervisor_internet === true;

  if (!falsoNegativo) {
    if (h.since || h.pending) {
      console.log('[infraguard] conectividad del anfitrión correcta otra vez');
      if (h.pending) {
        await avisar('✅ Jarvis: Home Assistant vuelve a tener internet tras el reinicio. Las actualizaciones ya no están bloqueadas.');
      }
    }
    h.since = 0; h.pending = false;
    return 'ok';
  }

  if (!h.since) {
    h.since = ahora;
    console.log('[infraguard] ⚠️ host_internet=false con supervisor_internet=true — empiezo a contar');
    return 'empieza';
  }
  const durMin = Math.round((ahora - h.since) / 60_000);
  if (ahora - h.since < HOST_FAIL_MIN_MS) return 'esperando';

  const zona = await getZona();
  const min = minutoDelDia(new Date(ahora), zona);
  if (min >= BACKUP_WINDOW.desdeMin && min < BACKUP_WINDOW.hastaMin) {
    console.log(`[infraguard] falso negativo de conectividad desde hace ${durMin} min, pero estamos en la ventana de backups: espero`);
    return 'ventana_backup';
  }

  if (h.rebootsToday >= HOST_MAX_REBOOTS_DAY) {
    if (!h.capNotified) {
      h.capNotified = true;
      anotar({
        priority: 'critical',
        title: 'HA sigue creyendo que no tiene internet tras reiniciar',
        detail: `host_internet=false con supervisor_internet=true desde hace ${durMin} min, y ya reinicié el anfitrión hoy. ` +
                `El reinicio no es la cura esta vez: revisa la red de la VM (puerto 80 de salida, DNS del host).`,
      });
      await avisar('🚨 Jarvis: HA vuelve a creer que no tiene internet y ya lo reinicié hoy. No insisto: el problema es otro. Revisa la red de la VM.');
    }
    return 'tope';
  }

  // Avisar ANTES: el reinicio nos apaga a nosotros también.
  await avisar(`🔄 Jarvis: Home Assistant cree que no tiene internet desde hace ${durMin} min aunque sí lo tiene, y eso bloquea las actualizaciones. Reinicio el anfitrión; vuelvo en unos minutos.`);
  // Guardar ANTES de reiniciar. Si no, tras el arranque no sabríamos que ya lo
  // hicimos y podríamos reiniciar en bucle. `since` se pone a 0 para dar al
  // sistema recién arrancado sus 15 minutos antes de volver a juzgarlo.
  h.rebootsToday += 1;
  h.lastRebootAt = ahora;
  h.pending = true;
  h.since = 0;
  guardar();
  try {
    await reboot();
    console.log('[infraguard] 🔄 reinicio del anfitrión solicitado');
    return 'reiniciado';
  } catch (e) {
    h.pending = false;
    guardar();
    console.log(`[infraguard] no pude reiniciar el anfitrión: ${e.message}`);
    anotar({
      priority: 'critical',
      title: 'HA cree que no tiene internet y no pude reiniciarlo',
      detail: `host_internet=false con supervisor_internet=true. El reinicio falló: ${e.message}. Reinícialo a mano: Ajustes → Sistema → Reiniciar.`,
    });
    await avisar(`🚨 Jarvis: HA cree que no tiene internet y no he podido reiniciarlo (${e.message}). Hazlo a mano desde Ajustes → Sistema.`);
    return 'fallo_reinicio';
  }
}

// ── Loop principal ──────────────────────────────────────────────────────────
async function infraGuardLoop() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const st = loadJSON(STATE_FILE, { day: today, addons: {}, entityFails: {} });
    if (st.day !== today) {
      st.day = today;
      // Resetear contadores diarios pero conservar estado de confirmación
      for (const k of Object.keys(st.addons)) {
        if (st.addons[k]) st.addons[k].actionsToday = 0;
      }
      for (const k of Object.keys(st.entityFails)) {
        if (st.entityFails[k]) {
          st.entityFails[k].actionsToday = 0;
          st.entityFails[k].capNotified  = false;   // dia nuevo, aviso nuevo
        }
      }
      if (st.host) { st.host.rebootsToday = 0; st.host.capNotified = false; }
    }

    // Conectividad del anfitrión: va primero, porque si dispara un reinicio el
    // resto de comprobaciones de esta vuelta da igual.
    try { await checkHostInternet(st); }
    catch (e) { console.log(`[infraguard] checkHostInternet: ${e.message}`); }

    const addons = await getAddons();

    // ── 1) Crash detection vía Supervisor ─────────────────────────────────
    for (const addon of addons) {
      // Los add-ons instalados desde un repositorio local llevan el prefijo
      // "local_" en el slug real (p.ej. "local_jarvis_ai_agent") — no coincide
      // con el nombre exacto declarado en config.yaml. Se usa .some(includes)
      // en vez de comparación exacta para no fallar el guardarraíl "no suicidarse".
      if ([...NEVER_RESTART].some(s => addon.slug.includes(s))) continue;
      if (addon.state !== 'error') {
        // Si se recuperó solo → limpiar confirmación pendiente
        if (st.addons[addon.slug]?.confirmed) {
          st.addons[addon.slug].confirmed = false;
        }
        continue;
      }

      const adSt = st.addons[addon.slug] || { actionsToday: 0, lastActionAt: 0, confirmed: false };

      // Primera detección → marcar y esperar siguiente ciclo (doble confirmación)
      if (!adSt.confirmed) {
        adSt.confirmed = true;
        st.addons[addon.slug] = adSt;
        console.log(`[infraguard] ⚠️  "${addon.name}" (${addon.slug}) en error — esperando confirmación`);
        continue;
      }

      // Guardarraíles
      const sinceLast = Date.now() - (adSt.lastActionAt || 0);
      if (sinceLast < COOLDOWN_MS) {
        const restanMin = Math.round((COOLDOWN_MS - sinceLast) / 60_000);
        console.log(`[infraguard] "${addon.name}" sigue en error, cooldown activo (${restanMin}min)`);
        continue;
      }
      if (adSt.actionsToday >= MAX_ACTIONS_DAY) {
        // Solo avisamos una vez (cuando se alcanza el tope)
        if (!adSt.capNotified) {
          adSt.capNotified = true;
          st.addons[addon.slug] = adSt;
          recordThought({
            priority: 'critical',
            title: `Add-on "${addon.name}" crashea repetidamente — reinicios agotados`,
            detail: `He reiniciado "${addon.name}" (${addon.slug}) ${MAX_ACTIONS_DAY} veces hoy ` +
                    `y sigue en estado error. Necesita revisión manual.`,
          });
          await notify(`🚨 Jarvis: "${addon.name}" lleva crasheando todo el día (${MAX_ACTIONS_DAY} reinicios agotados). Necesita revisión manual.`);
        }
        continue;
      }

      // ─ Actuar ─
      console.log(`[infraguard] 🔄 Reiniciando add-on crasheado: "${addon.name}" (${addon.slug})`);
      try {
        await restartAddon(addon.slug);
        adSt.lastActionAt = Date.now();
        adSt.actionsToday = (adSt.actionsToday || 0) + 1;
        adSt.confirmed    = false;
        adSt.capNotified  = false;
        st.addons[addon.slug] = adSt;

        recordThought({
          priority: 'high',
          title: `Auto-reparé: reinicié add-on crasheado "${addon.name}"`,
          detail: `El add-on "${addon.name}" (${addon.slug}) estaba en estado error. Lo reinicié automáticamente vía Supervisor.`,
        });
        await notify(`🛡️ Jarvis: el add-on *"${addon.name}"* había crasheado. Lo reinicié automáticamente.`);
      } catch (e) {
        console.log(`[infraguard] Error reiniciando "${addon.slug}": ${e.message}`);
        adSt.confirmed = false; // reintentar en el próximo ciclo si sigue fallando
        st.addons[addon.slug] = adSt;
        recordThought({
          priority: 'critical',
          title: `Add-on crasheado y no pude reiniciarlo: "${addon.name}"`,
          detail: `El add-on "${addon.name}" (${addon.slug}) está en estado error y el reinicio falló: ${e.message}. Revísalo manualmente.`,
        });
      }
    }

    // ── 2) Checks por entidad de HA (integraciones con health sensor) ──────
    for (const check of ENTITY_CHECKS) {
      let entityState;
      try {
        const res = await haGet(`/states/${check.entity}`);
        entityState = res?.state;
      } catch {
        // Entidad inexistente → instalación sin este servicio, ignorar silenciosamente
        continue;
      }
      if (!entityState) continue;

      const failSt = st.entityFails[check.id] || { count: 0, actionsToday: 0, lastActionAt: 0 };
      const isBad  = check.badStates.includes(entityState);

      if (!isBad) {
        if (failSt.count > 0 || failSt.capNotified) {
          console.log(`[infraguard] ✅ ${check.name} recuperada (estado: ${entityState})`);
          failSt.count = 0;
          failSt.capNotified = false;
        }
        st.entityFails[check.id] = failSt;
        continue;
      }

      failSt.count += 1;
      st.entityFails[check.id] = failSt;

      if (failSt.count < CONFIRM_LOOPS) {
        console.log(`[infraguard] ⚠️ ${check.name} en estado "${entityState}" (${failSt.count}/${CONFIRM_LOOPS})`);
        continue;
      }

      // Guardarraíles
      const sinceLast = Date.now() - (failSt.lastActionAt || 0);
      if (sinceLast < COOLDOWN_MS) continue;
      if (failSt.actionsToday >= MAX_ACTIONS_DAY) {
        // Antes esto era un `continue` a secas: agotados los reinicios del dia,
        // Jarvis se callaba el resto de la jornada aunque el puente siguiera
        // caido. Justo el vigilante mudo que este proyecto existe para evitar.
        // La ruta de add-ons ya avisaba con capNotified; esta no.
        if (!failSt.capNotified) {
          failSt.capNotified = true;
          st.entityFails[check.id] = failSt;
          recordThought({
            priority: 'critical',
            title: `${check.name} sigue cayendose — reinicios agotados`,
            detail: `La entidad "${check.entity}" sigue en estado "${entityState}" despues de ` +
                    `${MAX_ACTIONS_DAY} reinicios hoy. No vuelvo a tocarlo: necesita revision manual.`,
          });
          await notify(`🚨 Jarvis: *${check.name}* sigue cayendose tras ${MAX_ACTIONS_DAY} reinicios hoy. No insisto mas: revisalo a mano.`);
        }
        continue;
      }

      // Encontrar el add-on candidato
      const targetAddon = check.addonPattern
        ? addons.find(a => check.addonPattern.test(a.slug))
        : null;

      if (!targetAddon) {
        console.log(`[infraguard] ${check.name} caída pero no encontré add-on coincidente para reiniciar`);
        continue;
      }

      console.log(`[infraguard] 🔄 ${check.name} caída → reiniciando "${targetAddon.name}" (${targetAddon.slug})`);
      try {
        await restartAddon(targetAddon.slug);
        failSt.lastActionAt  = Date.now();
        failSt.actionsToday  = (failSt.actionsToday || 0) + 1;
        failSt.count         = 0;
        st.entityFails[check.id] = failSt;

        recordThought({
          priority: 'high',
          title: `Auto-reparé: ${check.name} no conectaba`,
          detail: `La entidad "${check.entity}" llevaba ${CONFIRM_LOOPS} ciclos en estado "${entityState}". ` +
                  `Reinicié "${targetAddon.name}" (${targetAddon.slug}) automáticamente.`,
        });
        await notify(`🛡️ Jarvis: *${check.name}* no conectaba (estado: ${entityState}). Reinicié el add-on "${targetAddon.name}".`);
      } catch (e) {
        console.log(`[infraguard] Error reiniciando ${targetAddon.slug}: ${e.message}`);
        failSt.count = 0; // resetear para reintento en CONFIRM_LOOPS ciclos
        st.entityFails[check.id] = failSt;
        recordThought({
          priority: 'critical',
          title: `${check.name} caída y no pude reiniciar el add-on`,
          detail: `La entidad "${check.entity}" está en "${entityState}" y el reinicio de "${targetAddon.name}" falló: ${e.message}.`,
        });
      }
    }

    saveJSON(STATE_FILE, st);
  } catch (e) {
    console.log(`[infraguard] Error: ${e.message}`);
  }
}

module.exports = { infraGuardLoop, checkHostInternet, minutoDelDia };
