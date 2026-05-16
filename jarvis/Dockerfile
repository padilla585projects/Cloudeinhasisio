ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm iproute2 iputils

WORKDIR /app

COPY package.json ./
# ARG VERSION fuerza rebuild del layer npm en cada versión nueva (rompe cache de Docker)
ARG VERSION=3.30.7
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

CMD ["/run.sh"]
