#!/usr/bin/env bash
# 更新线上版本：拉取最新代码并重启容器。手动执行，或由 GitHub Actions 通过 SSH 调用。
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
echo ">>> 已部署：$(git rev-parse --short HEAD)"
docker compose logs --tail=5 app
