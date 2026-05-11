# ═══════════════════════════════════════════════════════════════════════════════
# SYNC SCRIPT — Mantiene el repo actualizado en cualquier máquina
# ═══════════════════════════════════════════════════════════════════════════════
# USO: Ejecutar desde PowerShell en la carpeta del repo
#   .\sync.ps1           → Pull una vez
#   .\sync.ps1 -watch    → Monitoriza cambios cada 30s (dejar corriendo en background)
#   .\sync.ps1 -push     → Commit + push de cambios locales
# ═══════════════════════════════════════════════════════════════════════════════

param(
    [switch]$watch,
    [switch]$push,
    [int]$interval = 30
)

$ErrorActionPreference = "SilentlyContinue"

function Write-Status($msg) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $msg" -ForegroundColor Cyan
}

function Sync-Pull {
    Write-Status "Sincronizando desde remoto..."
    git fetch origin main 2>$null
    $behind = git rev-list --count HEAD..origin/main 2>$null
    if ($behind -gt 0) {
        git pull --rebase origin main
        Write-Status "Actualizado: $behind commits nuevos"
        return $true
    } else {
        Write-Status "Ya actualizado."
        return $false
    }
}

function Sync-Push {
    $status = git status --porcelain
    if ($status) {
        Write-Status "Cambios detectados, haciendo commit..."
        git add -A
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
        git commit -m "sync: cambios desde $(hostname) [$timestamp]"
        git push origin main
        Write-Status "Push completado."
    } else {
        Write-Status "Sin cambios locales."
    }
}

# ── Modo push ──
if ($push) {
    Sync-Push
    exit 0
}

# ── Modo watch (monitorizar continuamente) ──
if ($watch) {
    Write-Status "Modo watch activado (cada ${interval}s). Ctrl+C para parar."
    while ($true) {
        Sync-Pull
        Start-Sleep -Seconds $interval
    }
}

# ── Modo normal: pull una vez ──
Sync-Pull
