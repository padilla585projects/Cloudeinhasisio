FROM ghcr.io/home-assistant/amd64-base:latest

# Instalar Python y dependencias
RUN apk add --no-cache python3 py3-pip gcc musl-dev libffi-dev python3-dev

WORKDIR /app

COPY app/requirements.txt .
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

COPY app/ .
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
