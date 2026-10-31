# Build stage: install every workspace and build the web app.
FROM node:24-slim AS build
WORKDIR /app
COPY . .
RUN npm ci \
 && npm run build -w @notes/web

# Runtime stage: the server runs TypeScript source through tsx, so there is no
# compile step. Only the built web app is copied from the build stage.
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_ROOT=/app/apps/web/dist
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# The default PGlite directory is .data/pglite. Unused when DATABASE_URL is set,
# but the directory must be writable by the non-root user if it is used.
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
