'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// OMV-API — Cliente de la API RPC de OpenMediaVault (el NAS de casa)
//
// OMV no expone una API REST: todo pasa por un único endpoint POST /rpc.php con
// un cuerpo {service, method, params}. La sesión es una cookie, así que hay que
// hacer login primero y reutilizar la cookie mientras siga viva.
//
// Los nombres de servicio/método de aquí están verificados contra un OMV 8.5.6
// real (`omv-rpc` + los .inc de /usr/share/openmediavault/engined/rpc/), no
// sacados de la documentación — la API RPC de OMV no está documentada.
//
// Coste de tokens: CERO. Este módulo no llama a ningún LLM.
// ─────────────────────────────────────────────────────────────────────────────
const fetch = require('node-fetch');
const C = require('./constants');

// La cookie de sesión dura ~30 min; la renovamos sola cuando caduca.
let sessionCookie = null;
let sessionAt     = 0;
let loginInFlight = null;   // single-flight: ver login()
const SESSION_TTL = 20 * 60_000;

function omvConfigured() {
  return Boolean(C.OMV_URL && C.OMV_USER && C.OMV_PASSWORD);
}

async function rpcRaw(service, method, params = {}, cookie = null) {
  const res = await fetch(`${C.OMV_URL.replace(/\/$/, '')}/rpc.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ service, method, params, options: null }),
    timeout: 15_000,
  });
  // OJO: OMV devuelve HTTP 400 en los errores de aplicación, con el motivo real
  // en el cuerpo ("Incorrect username or password", "Session expired"...). Hay
  // que parsear el JSON ANTES de mirar el código de estado, o se pierde el
  // mensaje útil y todo se convierte en un inútil "HTTP 400".
  let json = null;
  try { json = await res.json(); } catch {}
  if (json?.error) {
    throw new Error(`OMV ${service}.${method} → ${json.error.message || 'error desconocido'}`);
  }
  if (!res.ok) throw new Error(`OMV ${service}.${method} → HTTP ${res.status}`);
  return { data: json?.response, setCookie: res.headers.get('set-cookie') };
}

// Single-flight: varias llamadas concurrentes (nasguard lanza getDisks,
// getFilesystems y getServices con Promise.all) veian todas sessionCookie=null y
// hacian login cada una. Resultado: 3 sesiones por ciclo en vez de 1, y 3
// entradas de "Authorized login" en el log del NAS por cada chequeo. Ahora la
// primera que llega crea la promesa y las demas se enganchan a ella.
async function login() {
  if (loginInFlight) return loginInFlight;
  loginInFlight = doLogin().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

async function doLogin() {
  const { data, setCookie } = await rpcRaw('Session', 'login', {
    username: C.OMV_USER,
    password: C.OMV_PASSWORD,
  });
  if (!data?.authenticated) throw new Error('OMV rechazó las credenciales');
  // El header trae varias cookies separadas por coma; solo necesitamos los pares k=v.
  sessionCookie = (setCookie || '')
    .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
  sessionAt = Date.now();
  return sessionCookie;
}

// Llamada RPC con sesión: hace login si hace falta y reintenta una vez si la
// sesión había caducado por el otro lado.
async function omvRpc(service, method, params = {}) {
  if (!omvConfigured()) {
    throw new Error('NAS no configurado. Añade omv_url, omv_user y omv_password en la configuración del add-on.');
  }
  if (!sessionCookie || Date.now() - sessionAt > SESSION_TTL) await login();
  try {
    const { data } = await rpcRaw(service, method, params, sessionCookie);
    return data;
  } catch (e) {
    if (!/session|autentic|authenticat|denied/i.test(e.message)) throw e;
    await login();
    const { data } = await rpcRaw(service, method, params, sessionCookie);
    return data;
  }
}

// ── Lecturas de alto nivel ──────────────────────────────────────────────────

// Salud SMART por disco. `overallstatus` es el veredicto del propio OMV:
// GOOD | BAD_SECTOR | BAD_ATTRIBUTE | BAD_SECTOR_ATTRIBUTE | UNKNOWN
async function getDisks() {
  const r = await omvRpc('Smart', 'getList', { start: 0, limit: -1 });
  return (r?.data || []).map(d => ({
    device: d.devicename,
    model: d.model,
    serial: d.serialnumber,
    tempC: d.temperature ? Number(d.temperature) : null,
    status: d.overallstatus,
    monitored: Boolean(d.monitor),
    sizeGB: d.size ? Math.round(Number(d.size) / 1e9) : null,
  }));
}

// Atributos SMART crudos de un disco (para ver la evolución de los contadores)
async function getDiskAttributes(devicefile) {
  const r = await omvRpc('Smart', 'getAttributes', { devicefile });
  const interesting = new Set([5, 187, 188, 197, 198, 199]);
  return (r || [])
    .filter(a => interesting.has(Number(a.id)))
    .map(a => ({ id: Number(a.id), name: a.attrname, raw: a.rawvalue, threshold: a.threshold }));
}

// Uso de los volúmenes montados
async function getFilesystems() {
  const r = await omvRpc('FileSystemMgmt', 'enumerateMountedFilesystems', {});
  return (r || []).map(f => ({
    device: f.devicename,
    mountpoint: f.mountpoint,
    label: f.label || null,
    type: f.type,
    usedPct: Number(f.percentage),
    used: f.used,
    availableGB: f.available ? Math.round(Number(f.available) / 1e9) : null,
  }));
}

// Servicios de OMV (SSH, SMB, NFS, Docker...)
async function getServices() {
  const r = await omvRpc('Services', 'getStatus', { start: 0, limit: -1 });
  return (r?.data || []).map(s => ({
    name: s.title || s.name,
    enabled: Boolean(s.enabled),
    running: Boolean(s.running),
  }));
}

// Contenedores Docker gestionados por el plugin compose
async function getContainers() {
  const r = await omvRpc('Compose', 'getContainerList', { start: 0, limit: -1 });
  return (r?.data || []).map(c => ({
    name: c.name,
    image: c.image,
    state: c.state,
    status: c.status,
  }));
}

module.exports = {
  omvConfigured, omvRpc,
  getDisks, getDiskAttributes, getFilesystems, getServices, getContainers,
};
