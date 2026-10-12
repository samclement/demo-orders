FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_CONFIG_LOGLEVEL=warn
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_CONFIG_LOGLEVEL=warn
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS runtime
ENV NODE_ENV=production
# OpenTelemetry: the image turns the SDK on (src/instrumentation.ts); the platform injects where to send it
# (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_SERVICE_NAME; make app-new --otlp).
# Logs go to stdout, which the platform collects, so the SDK does not export them too. Resource detectors:
# only local ones; the default list also asks Google Cloud, AWS and Azure metadata servers and logs a
# MetadataLookupWarning at every start.
# node:sqlite is still marked experimental in Node 24; its one start-up warning is silenced.
ENV NODE_OPTIONS="--import /app/dist/instrumentation.js --disable-warning=ExperimentalWarning" \
    OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process,serviceinstance,container \
    OTEL_TRACES_EXPORTER=otlp \
    OTEL_METRICS_EXPORTER=otlp \
    OTEL_LOGS_EXPORTER=none \
    PORT=8080
WORKDIR /app
COPY --from=prod-deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=prod-deps --chown=65532:65532 /app/package.json ./package.json
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --chown=65532:65532 migrations ./migrations
COPY --chown=65532:65532 asyncapi.yaml ./asyncapi.yaml
EXPOSE 8080
CMD ["dist/main.js"]
