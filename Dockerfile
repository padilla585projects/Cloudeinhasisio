ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js
RUN apk add --no-cache nodejs npm

# Set workdir
WORKDIR /app

# Copy package files
COPY app/package.json ./
RUN npm install --production

# Copy app files
COPY app/ ./

# Copy run script
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
