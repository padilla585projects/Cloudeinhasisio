ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm iproute2 iputils

WORKDIR /app

# npm install se cachea: solo se relanza cuando package.json cambia (no en cada versión)
COPY package.json ./
RUN npm install --production

# ARG VERSION DESPUÉS del npm install: invalida el cache de código en cada versión
# pero NO el layer de npm → mucho más rápido en updates (~10s vs ~3min)
ARG VERSION=3.34.6
RUN echo "Jarvis v${VERSION} — deps cacheadas, código copiado"

# Código principal
COPY server.js ./
COPY index.html ./

# Módulos extraídos durante Bloque A (v3.25.0+) — IMPRESCINDIBLE
COPY utils/      ./utils/
COPY tools/      ./tools/
COPY nexus/      ./nexus/
COPY background/ ./background/

COPY run.sh /run.sh
RUN chmod +x /run.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', function(r){process.exit(r.statusCode===200?0:1)}).on('error',function(){process.exit(1)})"

CMD ["/run.sh"]
