# Base Node.js image
FROM node:20-slim

# Install LibreOffice and comprehensive font support
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libreoffice-core \
        libreoffice-writer \
        fonts-dejavu-core \
        fonts-dejavu \
        fonts-liberation \
        fonts-liberation2 \
        fonts-opensymbol \
        fonts-noto \
        fonts-noto-cjk \
        fonts-indic \
        xfonts-base \
        xfonts-75dpi \
        xfonts-100dpi \
        wget curl unzip \
        && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production package files
COPY package.json .

RUN npm install

# Copy app files
COPY index.js .

# Create temp directory for conversions
RUN mkdir -p /tmp/docx-pdf-conversion
# Expose port for Cloud Run
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start production server
CMD ["npm", "start"]