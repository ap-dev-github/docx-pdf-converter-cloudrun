FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libreoffice-core \
        libreoffice-writer \
        python3 \
        python3-pip \
        python3-uno \
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

# Pre-warm LibreOffice user profile and font cache at BUILD time
# This bakes the profile into the image so every container starts warm
RUN mkdir -p /opt/lo-profile && \
    echo "Pre-warming LibreOffice profile..." && \
    soffice --headless --invisible \
        -env:UserInstallation=file:///opt/lo-profile \
        --convert-to pdf --outdir /tmp /dev/null 2>/dev/null || true && \
    echo "Profile warm complete"

WORKDIR /app

COPY package.json .
RUN npm install

COPY index.js .

RUN mkdir -p /tmp/docx-pdf-conversion

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "index.js"]