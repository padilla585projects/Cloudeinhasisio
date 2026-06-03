'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// NETGUARD — Watchdog de red/DNS de código puro (SIN IA, SIN dependencia de nube)
//
// Por qué existe: cuando el DNS de la red se cae (p. ej. el Pi-hole de Proxmox
// con el resolutor colgado), el propio cerebro de Jarvis se queda ciego: no puede
// resolver api.openai.com / api.anthropic.com / api.telegram.org. Así que este
// vigilante NO usa LLM. Detecta la caída resolviendo dominios reales, y si Proxmox
// está configurado reinicia el contenedor de Pi-hole POR IP (la API de Proxmox va
// por IP:8006, no necesita DNS — funciona justo cuando todo lo demás falla).
//
// Tras recuperar la red, recién entonces avisa por Telegram y registra el evento.
// Guardarraíles: cooldown entre acciones + tope diario + verificación de recuperación.
// ─────────────────────────────────────────────────────────────────────────────
const dns = require('dns');
const path = require('path');
const fetch = require('node-fetch');
const { loadJSON, saveJSON } = require('../utils/persistence');
const { haPost } = require('../utils/ha-api');
const C = require('../utils/constants');

const STATE_FILE = path.join(C.DATA_DIR, 'netguard_state.json');
const THOUGHTS_FILE = path.join(C.DATA_DIR, 'pending_thoughts.json');

// Dominios robustos para sondear (si NINGUNO resuelve → DNS caído)
const PROBE_DOMAINS = ['github.com', 'cloudflare.com', 'api.openai.com'];
// Contenedores candidatos a ser el DNS de la red (auto-detección por nombre)
const DNS_GUEST_RX = /pi.?hole|adguard|unbound|\bdns\b/i;

// Guardarraíles
const COOLDOWN_MS = 10 * 60_000;   // mínimo 10 min entre reinicios
const MAX_ACTIONS_DAY = 6;         // tope de reinicios automáticos por día
const RECHECK_DELAY_MS = 90_000;   // esperar 90s tras reiniciar para re-verificar

// ── Sondeo DNS puro (con timeout, sin depender de la nube) ──────────────────
function resolveOnce(domain, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
    dns.lookup(domain, (err) => {
      if (done) return;
      done = true; clearTimeout(t);
      resolve(!err);
    });
  });
}

async function dnsAlive() {
  // Resuelve si AL MENOS un dominio responde (evita falsos positivos por un dominio caído)
  for (const d of PROBE_DOMAINS) {
    if (await resolveOnce(d)) return true;
  }
  return false;
}

// ¿Hay internet por IP aunque el DNS falle? (distingue "solo DNS" de "corte total")
async function ipAlive() {
  try {
    const res = await fetch('https://1.1.1.1/', { timeout: 5000 });
    return res.ok || res.status > 0;
  } catch { return false; }
}

// ── Cliente Proxmox mínimo (por IP, no necesita DNS) ────────────────────────
function proxClient() {
  if (!C.PROXMOX_URL || !C.PROXMOX_TOKEN) return null;
  const node = C.PROXMOX_NODE;
  const auth = `PVEAPIToken=${C.PROXMOX_TOKEN}`;
  const get = async (ep) => {
    const res = await fetch(`${C.PROXMOX_URL}/api2/json${ep}`, { headers: { Authorization: auth }, timeout: 8000 });
    if (!res.ok) throw new Error(`GET ${ep} → ${res.status}`);
    return res.json();
  };
  const post = async (ep, body = {}) => {
    const res = await fetch(`${C.PROXMOX_URL}/api2/json${ep}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(), timeout: 8000
    });
    if (!res.ok) throw new Error(`POST ${ep} → ${res.status}`);
    return res.json();
  };
  return { node, get, post };
}

// Encuentra y reinicia el contenedor de DNS. Devuelve {acted, guest, mode} o {acted:false, reason}
// CLÚSTER-AWARE: busca en TODOS los nodos (pve1, pve2, ...), no solo en PROXMOX_NODE,
// porque el Pi-hole puede vivir en cualquier nodo del clúster.
async function restartDnsGuest() {
  const px = proxClient();
  if (!px) return { acted: false, reason: 'proxmox_no_configurado' };

  // 1) Enumerar nodos del clúster
  let nodes;
  try {
    const nodeList = await px.get('/nodes');
    nodes = (nodeList.data || []).filter(n => n.status !== 'offline').map(n => n.node);
  } catch (e) {
    // Fallback: si /nodes falla, al menos probar el nodo configurado
    nodes = [px.node];
  }
  if (nodes.length === 0) nodes = [px.node];

  // 2) Buscar el contenedor de DNS en cada nodo
  let match = null, foundNode = null;
  for (const node of nodes) {
    try {
      const lxc = await px.get(`/nodes/${node}/lxc`);
      const c = (lxc.data || []).find(c => DNS_GUEST_RX.test(c.name || ''));
      if (c) { match = c; foundNode = node; break; }
    } catch { /* nodo inalcanzable, seguir con el siguiente */ }
  }
  if (!match) return { acted: false, reason: 'sin_contenedor_dns_coincidente' };

  const vmid = match.vmid;
  try {
    if (match.status === 'running') {
      await px.post(`/nodes/${foundNode}/lxc/${vmid}/status/reboot`);
      return { acted: true, guest: match.name, vmid, node: foundNode, mode: 'reboot' };
    } else {
      await px.post(`/nodes/${foundNode}/lxc/${vmid}/status/start`);
      return { acted: true, guest: match.name, vmid, node: foundNode, mode: 'start' };
    }
  } catch (e) {
    // Fallback: reboot puede fallar en algunas plantillas → stop + start
    try {
      await px.post(`/nodes/${foundNode}/lxc/${vmid}/status/stop`);
      await new Promise(r => setTimeout(r, 4000));
      await px.post(`/nodes/${foundNode}/lxc/${vmid}/status/start`);
      return { acted: true, guest: match.name, vmid, node: foundNode, mode: 'stop_start' };
    } catch (e2) {
      return { acted: false, reason: `reinicio_fallido: ${e2.message}`, guest: match.name, vmid, node: foundNode };
    }
  }
}

function recordThought(t) {
  try {
    const thoughts = loadJSON(THOUGHTS_FILE, []);
    thoughts.push({
      id: Date.now(), type: 'netguard', status: 'pending',
      created: new Date().toISOString(), ...t
    });
    saveJSON(THOUGHTS_FILE, thoughts);
  } catch {}
}

async function notify(msg) {
  // Vía servicio de HA (local); HA core ya tiene DNS porque la red se recuperó
  try { await haPost('/services/notify/telegram', { message: msg }); } catch {}
}

// ── Loop principal del watchdog ─────────────────────────────────────────────
async function netGuardLoop() {
  try {
    // 1) ¿DNS vivo? Si sí, nada que hacer (y limpiamos estado de incidencia)
    if (await dnsAlive()) {
      const st = loadJSON(STATE_FILE, {});
      if (st.incidentOpen) {
        st.incidentOpen = false;
        st.lastRecoveredAt = new Date().toISOString();
        saveJSON(STATE_FILE, st);
      }
      return;
    }

    // 2) DNS caído — confirmar con un segundo intento espaciado (evita falsos positivos)
    await new Promise(r => setTimeout(r, 5000));
    if (await dnsAlive()) return;

    console.log('[netguard] ⚠️ DNS caído: ningún dominio resuelve.');
    const ipOk = await ipAlive();
    console.log(`[netguard] Conectividad por IP: ${ipOk ? 'OK (es problema solo de DNS)' : 'también caída (corte más amplio)'}`);

    // 3) Guardarraíles: cooldown + tope diario
    const today = new Date().toISOString().slice(0, 10);
    const st = loadJSON(STATE_FILE, { actionsToday: 0, day: today, lastActionAt: 0, incidentOpen: false });
    if (st.day !== today) { st.day = today; st.actionsToday = 0; }
    st.incidentOpen = true;

    const sinceLast = Date.now() - (st.lastActionAt || 0);
    if (sinceLast < COOLDOWN_MS) {
      console.log(`[netguard] En cooldown (${Math.round((COOLDOWN_MS - sinceLast) / 1000)}s restantes). No actúo aún.`);
      saveJSON(STATE_FILE, st); return;
    }
    if (st.actionsToday >= MAX_ACTIONS_DAY) {
      console.log('[netguard] Tope diario de reinicios alcanzado. Registro aviso para revisión humana.');
      recordThought({
        priority: 'critical',
        title: 'DNS caído repetidamente — reinicios automáticos agotados',
        detail: `He reiniciado el contenedor de DNS ${MAX_ACTIONS_DAY} veces hoy y sigue cayendo. Necesita revisión manual del Pi-hole / upstream / red de Proxmox.`
      });
      saveJSON(STATE_FILE, st); return;
    }

    // 4) Actuar: reiniciar el contenedor de Pi-hole por IP (sin DNS)
    const result = await restartDnsGuest();
    st.lastActionAt = Date.now();
    st.actionsToday += 1;
    saveJSON(STATE_FILE, st);

    if (!result.acted) {
      console.log(`[netguard] No pude auto-reparar: ${result.reason}`);
      recordThought({
        priority: 'critical',
        title: 'DNS caído y no pude reiniciar el Pi-hole automáticamente',
        detail: `El DNS de la red no resuelve. Motivo por el que no actué: ${result.reason}.\n` +
                `${result.reason === 'proxmox_no_configurado' ? 'Configura PROXMOX_URL/PROXMOX_TOKEN para que pueda reiniciarlo solo.' : 'Revisa el contenedor de Pi-hole manualmente.'}`
      });
      return;
    }

    console.log(`[netguard] ✅ Reiniciado contenedor DNS "${result.guest}" (vmid ${result.vmid} en nodo ${result.node}, modo ${result.mode}). Verificando recuperación en ${RECHECK_DELAY_MS / 1000}s...`);

    // 5) Esperar y verificar recuperación
    await new Promise(r => setTimeout(r, RECHECK_DELAY_MS));
    const recovered = await dnsAlive();

    if (recovered) {
      const st2 = loadJSON(STATE_FILE, st);
      st2.incidentOpen = false;
      st2.lastRecoveredAt = new Date().toISOString();
      saveJSON(STATE_FILE, st2);
      const when = new Date().toLocaleString('es-ES');
      console.log('[netguard] ✅ DNS recuperado tras el reinicio.');
      recordThought({
        priority: 'high',
        title: `Auto-reparé la red: DNS caído → reinicié Pi-hole → resuelto`,
        detail: `Detecté que el DNS de la red no resolvía (toda la casa sin internet por nombre). ` +
                `Reinicié el contenedor "${result.guest}" (vmid ${result.vmid}) en el nodo ${result.node} de Proxmox (${result.mode}) y la resolución volvió a las ${when}. ` +
                `Sin intervención tuya.`
      });
      await notify(`🛡️ Jarvis: detecté el DNS de la red caído y reinicié el Pi-hole ("${result.guest}") en Proxmox. ✅ Internet restaurado a las ${when}.`);
    } else {
      console.log('[netguard] ⚠️ DNS sigue caído tras el reinicio. Reintentaré en el próximo ciclo (con cooldown).');
      recordThought({
        priority: 'critical',
        title: 'Reinicié el Pi-hole pero el DNS sigue caído',
        detail: `Reinicié "${result.guest}" (vmid ${result.vmid}) pero la resolución no volvió. ` +
                `Posible causa más profunda: upstream DNS del Pi-hole mal configurado, o la red de Proxmox/WAN sin salida. Revisa manualmente.`
      });
    }
  } catch (e) {
    console.log(`[netguard] Error: ${e.message}`);
  }
}

module.exports = { netGuardLoop };
