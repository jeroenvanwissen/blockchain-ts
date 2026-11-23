# syntax=docker/dockerfile:1
# blockchain-ts node (TASK-0043). Build: docker build -t blockchain-ts .
# Run:   docker run -d --name node -v node-data:/data -p 5001:5001 -p 127.0.0.1:6001:6001 blockchain-ts [--mine] [--stake]
# CLI:   docker exec node cli balance

# Build stage: dev toolchain, compile to dist/, then drop dev dependencies
FROM node:26-slim AS build
# secp256k1 has no prebuilt addon for every platform (none for linux-arm64): compile it then,
# rather than fall back to its pure-JS code (about 40x slower)
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Fail the build if the native secp256k1 addon isn't there
RUN node -e "require('secp256k1/bindings')"
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: compiled node and production dependencies, run as the unprivileged node user
FROM node:26-slim
ENV NODE_ENV=production \
	DATA_DIR=/data \
	P2P_PORT=5001 \
	API_HOST=0.0.0.0 \
	API_PORT=6001
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/cli /usr/local/bin/cli
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
# P2P, and the API with the block explorer. Wallet routes answer only from inside the container
EXPOSE 5001 6001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
	CMD node -e "fetch('http://127.0.0.1:' + process.env.API_PORT + '/status').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# The node saves its chainstate and closes peers on SIGTERM (docker stop)
ENTRYPOINT ["node", "dist/index.js"]
CMD []
