ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-python:3.12
FROM $BUILD_FROM

# Instalar dependencias del sistema
RUN apk add --no-cache gcc musl-dev libffi-dev

# Directorio de trabajo
WORKDIR /app

# Copiar requirements primero para aprovechar cache de Docker
COPY app/requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copiar el resto de la app
COPY app/ .
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
