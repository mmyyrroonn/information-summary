# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl git openssh-client \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY prisma ./prisma
RUN npx prisma generate
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
