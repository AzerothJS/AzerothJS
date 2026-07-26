# One image for the whole app: stage 1 builds the client, stage 2 runs the server
# (which has NO build step - Node >= 24 runs the TypeScript source) and serves the
# built client from CLIENT_DIR. One origin, one container.
FROM node:24-slim AS client
WORKDIR /build
COPY package*.json ./
COPY application/package.json application/
COPY server/package.json server/
RUN npm ci
COPY application ./application
RUN npm run build --workspace application

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV CLIENT_DIR=./client
ENV SSR_ENTRY=./client-server/entry.server.js
# Workspace install, root context: the lockfile lives at the repo root (a workspace
# member never has its own), so stage 2 installs exactly like stage 1 does - all
# manifests + the root lockfile, scoped to the server workspace, dev deps omitted.
COPY package*.json ./
COPY application/package.json application/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace server
COPY server/src ./src
COPY --from=client /build/application/dist ./client
# The self-contained SSR bundle (vite build --ssr) - the kit renders 'server' pages with it.
COPY --from=client /build/application/dist-server ./client-server
EXPOSE 3000
CMD ["node", "src/main.ts"]
