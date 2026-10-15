#!/usr/bin/env bash
# 更新线上版本：拉取最新代码并重启容器。手动执行，或由 GitHub Actions 通过 SSH 调用。
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only 2>/dev/null || true          # 用 rsync 同步时没有 git 仓库，跳过
mkdir -p data sessions downloads && chown -R 1000:1000 data sessions downloads   # 容器内以 node(1000) 运行
docker compose up -d --build
docker image prune -f >/dev/null
echo ">>> 已部署：$(git rev-parse --short HEAD 2>/dev/null || echo 'rsync 同步的版本')"   # rsync 不传 .git，没有 commit 号
docker compose logs --tail=5 app
