# Plan de instalación: Ollama como IA local de Jarvis

Objetivo: que Jarvis use Ollama como motor principal y solo recurra a OpenAI/Anthropic cuando Ollama no responda. Ahorro de tokens cloud → cercano al 100% para uso normal.

El código del add-on ya está listo (v3.29.0). Lo único que falta es el hardware donde correr Ollama.

---

## 1. Decisión de hardware

### Opción A — Mini-PC nuevo (recomendado)
**Beelink SER5 / SER6** o equivalente:
- Ryzen 5 5500U / 5600U / 7530U
- **32 GB RAM** (importante para tener margen — el modelo 7B ocupa 5GB, dejas otros 27GB para sistema y modelos más grandes en el futuro)
- 500 GB SSD
- Sin GPU dedicada
- Precio: **300-400 €**
- Consumo idle: ~10 W
- Pros: silencioso, pequeño, eficiente, garantía
- Inferencia esperada con qwen2.5:7b: **10-15 tok/seg** (suficiente para Jarvis)

### Opción B — PC reacondicionado (más barato)
**HP EliteDesk 800 G4/G5** o **Dell Optiplex 7050/7060 Micro**:
- i5-8500T / i7-8700T
- 16 GB RAM (ampliable a 32)
- 256 GB SSD
- Precio: **120-200 €** (eBay, BackMarket)
- Consumo idle: ~8-12 W
- Pros: muy barato
- Contras: más viejo, sin garantía larga
- Inferencia esperada: **8-12 tok/seg**

### Opción C — Con GPU NVIDIA (si quieres velocidad de verdad)
**Mini-PC con eGPU** o **PC barato + RTX 3060 12GB**:
- Cualquier CPU decente + RTX 3060 12GB (usada ~200€)
- 16 GB RAM mínimo
- Precio total: **400-600 €**
- Inferencia: **50-100 tok/seg** (instantáneo)
- Pros: velocidad cloud-grade
- Contras: 100-200 W bajo carga, más ruido

### Opción D — Reaprovechar lo que tengas
- Si tienes un portátil viejo con 8GB+ RAM corriendo siempre → vale
- Si tienes una Raspberry Pi → **NO** (demasiado lenta para 7B, no merece la pena)

### Recomendación personal
**Opción B (HP EliteDesk reacondicionado, ~150€).** Es lo que mejor calidad/precio da para tu caso: comandos cortos en local, los pesados al cloud. No necesitas velocidad extrema porque el experto `rapido` solo maneja consultas simples.

Si en 6 meses quieres más velocidad, vendes el EliteDesk por 100€ y compras un Beelink.

---

## 2. Setup paso a paso (Ubuntu Server)

Una vez tengas el equipo:

### 2.1. Instalar Ubuntu Server 24.04 LTS
- Descargar ISO de ubuntu.com
- Flashear USB con Balena Etcher
- Instalar marcando OpenSSH server, sin GUI
- IP estática asignada por el router al MAC del equipo
- Anotar la IP de la LAN (ej. `192.168.1.50`)

### 2.2. Instalar Ollama
```bash
ssh user@192.168.1.50
curl -fsSL https://ollama.com/install.sh | sh
```

### 2.3. Hacer Ollama accesible desde la LAN
Por defecto Ollama solo escucha en `127.0.0.1`. Hay que abrirlo:

```bash
sudo systemctl edit ollama
```

Pegar:
```
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_KEEP_ALIVE=24h"
Environment="OLLAMA_NUM_PARALLEL=2"
```

Recargar y reiniciar:
```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Verificar desde tu PC:
```bash
curl http://192.168.1.50:11434/api/tags
```
Debe devolver `{"models":[]}`.

### 2.4. Descargar los modelos
```bash
ollama pull qwen2.5:7b-instruct      # modelo principal (~4.7 GB)
ollama pull qwen2.5:3b-instruct      # modelo background (~1.9 GB)
```

Total descarga: ~7 GB. Tiempo: 15-30 min según conexión.

### 2.5. Probarlo
```bash
ollama run qwen2.5:7b-instruct "Hola, ¿quién eres?"
```
Si responde en español → funciona.

---

## 3. Conectar Jarvis a Ollama

En Home Assistant → Add-ons → Jarvis AI Agent → Configuración:

```yaml
ollama_url: "http://192.168.1.50:11434"   # IP del equipo nuevo
ollama_model: "qwen2.5:7b-instruct"
ollama_bg_model: "qwen2.5:3b-instruct"
local_first: true                          # Ollama primero, cloud como backup
privacy_mode: false                        # false = permite fallback cloud
```

Guardar → Reiniciar add-on.

En los logs del add-on verás:
```
🏠 LOCAL_FIRST: Ollama primero, cloud como fallback
IA local (Ollama): http://192.168.1.50:11434 | modelo: qwen2.5:7b-instruct
```

---

## 4. Cómo funciona el fallback (transparente)

Cada request de Jarvis:

```
1. Jarvis decide qué experto usar (NEXUS router)
2. Llama a callLLM(modelo_del_experto, ...)
3. buildModelChain() decide la cadena:
   - LOCAL_FIRST=true → [ollama, cloud]
4. Intenta Ollama:
   ✓ OK → respuesta gratis
   ✗ Falla con error de red/timeout/5xx → cae a cloud automáticamente
   ✗ Falla con error 4xx (bad request) → NO cae, falla rápido
5. Si el fallback se activó, lo verás en logs:
   [llm-fallback] ✓ OpenAI (gpt-4.1-mini) tras fallar ollama/qwen2.5:7b-instruct
```

**Cuándo realmente vas a tirar de cloud:**
- Ollama está apagado (mantenimiento, reinicio)
- Ollama tarda demasiado (>90s en un tool call complejo)
- El modelo local devuelve un error de formato que no podemos parsear
- Tareas muy complejas que el 7B no puede resolver (raro, qwen2.5 es bueno)

**Estimación de ahorro:** si Ollama está al 95% de uptime y maneja el 90% de las queries → ahorro real del **~85% en tokens cloud**.

---

## 5. Opcional pero recomendado

### 5.1. Modo privacidad para datos sensibles
Cuando hables de algo personal/sensible, activa:
```yaml
privacy_mode: true
```
Y reinicia. NADA saldrá a internet, todo se procesa en tu LAN.

### 5.2. Modelos extra que vale la pena bajar
```bash
ollama pull llama3.2:3b              # ultra-rápido, alternativa al qwen 3b
ollama pull deepseek-r1:7b           # razonamiento (alternativa a Claude para dev)
ollama pull nomic-embed-text         # embeddings (para RAG futuro)
```

### 5.3. Monitorización (que sepas qué consume)
```bash
# CPU/RAM
htop

# GPU si tienes
nvidia-smi -l 1

# Logs Ollama
journalctl -u ollama -f
```

### 5.4. Auto-update de modelos
Crear `/etc/cron.weekly/ollama-update`:
```bash
#!/bin/bash
ollama pull qwen2.5:7b-instruct
ollama pull qwen2.5:3b-instruct
```
```bash
chmod +x /etc/cron.weekly/ollama-update
```

---

## 6. Resumen ejecutivo

**Lo que necesitas comprar:** 1 mini-PC de ~150€ (HP EliteDesk reacondicionado) o ~350€ (Beelink nuevo).

**Lo que necesitas hacer:** seguir secciones 2 y 3 — total 20-30 min de tu tiempo.

**Lo que ya está hecho:** todo el código de Jarvis (v3.29.0). Backend, fallback, expertos, config, endpoints. Solo te falta enchufar el hardware.

**Lo que ganas:** ahorro estimado **70-85% en costes de API** + privacidad cuando lo necesites + funcionamiento offline.

**Lo que pierdes:** un poco de calidad en consultas complejas (qwen 7B vs gpt-4.1) — pero precisamente para eso está el fallback automático a cloud.
