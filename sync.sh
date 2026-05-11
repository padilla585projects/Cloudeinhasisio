#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# SYNC SCRIPT — Mantiene el repo actualizado en cualquier máquina
# ═══════════════════════════════════════════════════════════════════════════════
# USO:
#   ./sync.sh           → Pull una vez
#   ./sync.sh --watch   → Monitoriza cambios cada 30s
#   ./sync.sh --push    → Commit + push de cambios locales
# ═══════════════════════════════════════════════════════════════════════════════

INTERVAL=30

status() {
  echo "[$(date +%H:%M:%S)] $1"
}

sync_pull() {
  status "Sincronizando desde remoto..."
  git fetch origin main 2>/dev/null
  BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null)
  if [ "$BEHIND" -gt 0 ]; then
    git pull --rebase origin main
    status "Actualizado: $BEHIND commits nuevos"
    return 0
  else
    status "Ya actualizado."
    return 1
  fi
}

sync_push() {
  if [ -n "$(git status --porcelain)" ]; then
    status "Cambios detectados, haciendo commit..."
    git add -A
    TIMESTAMP=$(date "+%Y-%m-%d %H:%M")
    git commit -m "sync: cambios desde $(hostname) [$TIMESTAMP]"
    git push origin main
    status "Push completado."
  else
    status "Sin cambios locales."
  fi
}

case "$1" in
  --push|-p)
    sync_push
    ;;
  --watch|-w)
    status "Modo watch activado (cada ${INTERVAL}s). Ctrl+C para parar."
    while true; do
      sync_pull
      sleep $INTERVAL
    done
    ;;
  *)
    sync_pull
    ;;
esac
