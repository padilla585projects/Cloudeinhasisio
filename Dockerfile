ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM

# Install Node.js
RUN apk add --no-cache nodejs npm

# Set workdir
WORKDIR /app

# Copy package file and install dependencies
COPY package.json ./
RUN npm install --production

# Copy server and public files
COPY server.js ./
COPY public/index.html ./public/index.html

# Copy run script
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
