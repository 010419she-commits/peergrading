# peergrading.ai — 生产镜像（Node 24，直接运行 TypeScript）
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# 收尾 Agent 在容器内以“本机直接运行”模式执行用户代码；给它 python3 与 git
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data sessions && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "server.ts"]
