ARG BUILD_FROM
FROM $BUILD_FROM

# Instalar Python y dependencias
RUN apk add --no-cache python3 py3-pip gcc musl-dev libffi-dev python3-dev

# Directorio de trabajo
WORKDIR /app

# Copiar requirements primero
COPY app/requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copiar el resto de la app
COPY app/ .
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
