# ============================================
# Stage 1: Install all dependencies (incl. dev, for the build)
# ============================================

ARG NODE_VERSION=24-slim

FROM node:${NODE_VERSION} AS dependencies

WORKDIR /app

# Build toolchain for native modules (bcrypt) — dropped from the final image
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package-related files to leverage Docker cache
COPY package.json yarn.lock ./

# Install with frozen lockfile for reproducible builds
RUN yarn install --frozen-lockfile

# ============================================
# Stage 2: Build the NestJS application
# ============================================

FROM node:${NODE_VERSION} AS builder

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production

# nest build -> dist/main.js
RUN yarn build

# ============================================
# Stage 3: Install production-only dependencies
# ============================================

FROM node:${NODE_VERSION} AS prod-dependencies

WORKDIR /app

# Build toolchain again — bcrypt compiles on install
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./

RUN yarn install --frozen-lockfile --production

# ============================================
# Stage 4: Production runner
# ============================================

FROM node:${NODE_VERSION} AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3003

# Slim runtime: production deps + compiled output only
COPY --from=prod-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Run as non-root user
USER node

EXPOSE 3003

CMD ["node", "dist/main.js"]
