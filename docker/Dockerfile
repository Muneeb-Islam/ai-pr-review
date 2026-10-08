#
# One build for every service (docs/operations.md). Multi-stage: dependencies and the build stay in the builder; the
# images that run contain only the bundled code and production dependencies, run as an unprivileged user, and hold
# no secret (secrets arrive at run time as environment variables or files).
#
#   docker build -f docker/Dockerfile --target api     -t ai-pr-review/api .
#   docker build -f docker/Dockerfile --target worker  -t ai-pr-review/worker .
#   docker build -f docker/Dockerfile --target migrate -t ai-pr-review/migrate .
#   docker build -f docker/Dockerfile --target web     -t ai-pr-review/web .
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine

# ---- the workspace manifests alone, so the dependency layers are cached until a package.json changes
FROM ${NODE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/shared/package.json packages/shared/

# ---- everything needed to build (dev dependencies included)
FROM manifests AS build-deps
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM build-deps AS build
COPY . .
RUN npm run build -w @ai-pr-review/api -w @ai-pr-review/worker -w @ai-pr-review/web \
 && npm run build:migrate -w @ai-pr-review/db

# ---- production dependencies of the services that run on Node
FROM manifests AS prod-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts \
      -w @ai-pr-review/api -w @ai-pr-review/worker -w @ai-pr-review/db

# ---- what every Node image shares: production mode, a non-root user, nothing else
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

FROM runtime AS worker
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --chown=node:node apps/worker/package.json ./apps/worker/package.json
WORKDIR /app/apps/worker
# The worker has no port: it touches this file every few seconds, and the check fails when it stops (a hung process).
ENV WORKER_LIVENESS_FILE=/tmp/aipr-worker-alive
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const s=require('fs').statSync(process.env.WORKER_LIVENESS_FILE);process.exit(Date.now()-s.mtimeMs<60000?0:1)"]
CMD ["node", "dist/index.js"]

FROM runtime AS migrate
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/db/dist/migrate.js ./migrate.js
COPY --chown=node:node packages/db/migrations ./migrations
COPY --chown=node:node packages/db/package.json ./package.json
ENV MIGRATIONS_FOLDER=/app/migrations
CMD ["node", "migrate.js"]

# ---- the dashboard: static files behind nginx, which also proxies /api, /auth and /webhooks to the api
FROM ${NGINX_IMAGE} AS web
COPY docker/nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/nginx-health"]
