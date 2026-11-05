# Planer-Server: gemeinsamer Echtzeit-Server für Netzwerkplaner und Stromplaner.
# Der Netzwerkplaner-Teil (Absichten, Prüfungen) wird aus ./netzwerkplaner/src/shared mitgebaut
# (Git-Submodul; vor dem Bauen: git submodule update --init).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY src ./src
COPY client ./client
COPY netzwerkplaner/src/shared ./netzwerkplaner/src/shared
RUN node scripts/build.js

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN apk add --no-cache su-exec \
  && npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# Kein USER node: das Entrypoint-Skript startet als root, richtet die Rechte auf
# DATA_DIR ein (Bind-Mount) und startet den Server dann per su-exec als node.
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
