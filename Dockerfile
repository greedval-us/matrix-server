# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node node ./node
COPY --chown=node:node protos ./protos
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/migrate.mjs scripts/copy_catalog.mjs scripts/access-keys.mjs ./scripts/
RUN mkdir -p /var/lib/matrix/files && chown node:node /var/lib/matrix/files
USER node
EXPOSE 50051
CMD ["node", "node/main.mjs"]

FROM api AS web-admin
COPY --chown=node:node scripts/hash-web-admin-password.mjs ./scripts/
EXPOSE 8443
CMD ["node", "node/web-admin/main.mjs"]

# searchd, indexer and indextool must use the same release in both Compose roles.
FROM manticoresearch/manticore:29.9.0 AS manticore
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 mariadb-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/build_manticore_indexes.py /app/scripts/build_manticore_indexes.py
COPY --chmod=0755 docker/manticore-entrypoint.sh /usr/local/bin/matrix-manticore-entrypoint
ENV PYTHONUNBUFFERED=1 \
    MANTICORE_DATA_DIR=/var/lib/manticore \
    MANTICORE_CONFIG=/var/lib/manticore/config/manticore.conf \
    MANTICORE_PID_FILE=/var/lib/manticore/runtime/searchd.pid \
    MANTICORE_LISTEN_HOST=0.0.0.0
ENTRYPOINT ["/usr/local/bin/matrix-manticore-entrypoint"]
CMD ["searchd", "--config", "/var/lib/manticore/config/manticore.conf", "--nodetach"]
