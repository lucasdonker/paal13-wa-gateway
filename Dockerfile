# Paal 13 WhatsApp-gateway (Baileys). Gebouwd door .github/workflows/wa-gateway.yml naar ghcr.io.
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    POORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src

# De sessie (koppeling met WhatsApp) staat hier; koppel er een TrueNAS-dataset aan.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:${POORT}/health || exit 1

CMD ["node", "src/server.js"]
