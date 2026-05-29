# ─────────────────────────────────────────────
#  Stage 1: deps only (cached layer on redeploy)
# ─────────────────────────────────────────────
FROM node:20-slim AS deps

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

# ─────────────────────────────────────────────
#  Stage 2: runtime image
# ─────────────────────────────────────────────
FROM node:20-slim

# Install Chromium from Debian repos (no extra download at runtime).
# Fonts cover Latin, CJK, Indic and emoji — same set the old image had.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-liberation2 \
        fonts-noto \
        fonts-noto-cjk \
        fonts-indic \
        fonts-noto-color-emoji \
        ca-certificates \
        curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Tell puppeteer-core where to find Chrome and skip its own download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    # Chromium needs a writable home; use a fixed path so it is
    # baked into the image layer rather than created at runtime
    HOME=/home/pptruser

# Non-root user required for Chromium --no-sandbox in containers
RUN groupadd -r pptruser && \
    useradd -r -g pptruser -d /home/pptruser -m pptruser && \
    mkdir -p /home/pptruser/.config/chromium && \
    chown -R pptruser:pptruser /home/pptruser

WORKDIR /app

# Copy pre-built node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY package.json .
COPY index.js .

# Temp dir for PDF output
RUN mkdir -p /tmp/html-pdf-conversion && \
    chown -R pptruser:pptruser /tmp/html-pdf-conversion /app

USER pptruser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "index.js"]