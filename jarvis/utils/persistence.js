'use strict';
const fs   = require('fs');
const path = require('path');
const { BACKUPS_DIR } = require('./constants');

let yaml;
try { yaml = require('js-yaml'); } catch { yaml = null; }

// ── JSON I/O ──────────────────────────────────────────────────────────────────

function loadJSON(filepath, fallback = []) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { console.log(`[load] Error en ${filepath}: ${e.message}`); }
  return fallback;
}

function saveJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// ── Validación YAML ───────────────────────────────────────────────────────────

function validateYamlSyntax(content) {
  if (yaml) {
    try {
      yaml.load(content);
    } catch (e) {
      return `Error YAML en línea ${e.mark?.line + 1 || '?'}: ${e.reason || e.message}`;
    }
    return null;
  }
  // Fallback manual
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (/^\t/.test(line)) return `Línea ${n}: tab encontrado — usa 2 espacios, nunca tabs`;
    const spaces = (line.match(/^( +)/) || ['', ''])[1].length;
    if (spaces % 2 !== 0 && line.trim() && !line.trim().startsWith('#'))
      return `Línea ${n}: indentación impar (${spaces} espacios) — usa múltiplos de 2`;
    if (/^\s*-[^\s\-]/.test(line) && !line.trim().startsWith('---'))
      return `Línea ${n}: lista mal formada — debe ser "- " (guión + espacio)`;
  }
  return null;
}

function validateHAStructure(content, fileType) {
  if (fileType === 'automations') {
    if (!content.includes('trigger:') && !content.includes('triggers:'))
      return 'Falta "trigger:" — toda automatización necesita al menos un trigger';
    if (!content.includes('action:') && !content.includes('actions:'))
      return 'Falta "action:" — toda automatización necesita al menos una acción';
    const ids = [];
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*id:\s*['"]?([^'"#\n]+?)['"]?\s*$/);
      if (m) {
        const id = m[1].trim();
        if (ids.includes(id)) return `ID duplicado: "${id}" — cada automatización debe tener un ID único`;
        ids.push(id);
      }
    }
  }
  if (fileType === 'scripts') {
    if (!content.includes('sequence:'))
      return 'Falta "sequence:" — todo script necesita una secuencia de acciones';
  }
  return null;
}

// ── Backup automático ─────────────────────────────────────────────────────────

function autoBackup(filepath) {
  try {
    if (!fs.existsSync(filepath)) return null;
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const safeName = filepath.replace(/[/\\:]/g, '_');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUPS_DIR, `${safeName}.${ts}.bak`);
    fs.copyFileSync(filepath, backupPath);
    const all = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith(safeName + '.'))
      .sort();
    if (all.length > 10) {
      for (const old of all.slice(0, all.length - 10))
        fs.unlinkSync(path.join(BACKUPS_DIR, old));
    }
    console.log(`[backup] ${path.basename(filepath)} → ${path.basename(backupPath)}`);
    return backupPath;
  } catch (e) {
    console.log(`[backup] Error: ${e.message}`);
    return null;
  }
}

module.exports = {
  loadJSON, saveJSON,
  validateYamlSyntax, validateHAStructure,
  autoBackup,
};
