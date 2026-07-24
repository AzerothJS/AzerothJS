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
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=client /build/application/dist ./client
EXPOSE 3000
CMD ["node", "src/main.ts"]
