# No build stage exists - Node >= 24 runs the TypeScript source directly.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
EXPOSE 3000
CMD ["node", "src/main.ts"]
