# ── Stage 1: 构建 Vue 前端 ──
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# ── Stage 2: 生产运行 ──
FROM node:20-alpine
RUN apk add --no-cache docker-cli docker-cli-compose curl bash

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js .
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PROJECT_DIR=/project
ENV ADMIN_PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
