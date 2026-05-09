# Multi-stage build to keep the runtime image small.
# Stage 1: install deps + build TS → dist
FROM node:20-alpine AS builder
WORKDIR /app
# Install pnpm directly via npm to avoid corepack's registry-lookup on build.
# pnpm 9 matches the lockfileVersion 9.0 in pnpm-lock.yaml.
RUN npm install -g pnpm@9 --registry=https://registry.npmmirror.com
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# Stage 2: runtime — only dist + node_modules + public
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public
EXPOSE 3002
# tini for proper signal handling on container stop
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
