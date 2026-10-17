#!/usr/bin/env bash
# 更新无账号下载站点并重启容器。手动执行，或由 GitHub Actions 通过 SSH 调用。
set -euo pipefail
cd "$(dirname "$0")/.."

revision="unknown (no Git metadata)"
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git pull --ff-only
  revision="$(git rev-parse --short HEAD)"
fi

docker compose up -d --build
docker image prune -f >/dev/null
echo ">>> 已部署：$revision"
docker compose logs --tail=5 app
