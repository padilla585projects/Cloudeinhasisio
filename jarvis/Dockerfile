ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm iproute2 iputils

WORKDIR /app

COPY package.json ./
# ARG VERSION fuerza rebuild del layer npm en cada versión nueva (rompe cache de Docker)
ARG VERSION=3.33.2
RUN echo "Instalando deps para Jarvis v${VERSION}..." && npm install --production

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
