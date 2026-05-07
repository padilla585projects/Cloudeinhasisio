ARG BUILD_FROM
FROM $BUILD_FROM

# Instalar Python y dependencias del sistema
RUN apk add --no-cache python3 py3-pip python3-dev gcc musl-dev

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
