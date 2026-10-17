# PeerGrading 无账号下载站点；本地桌面入口不会在此镜像中启动。
FROM node:24-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run bundle \
  && npm prune --omit=dev \
  && chown -R node:node /app

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "dist/site-server.mjs"]
