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
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "dist/server.js"]
