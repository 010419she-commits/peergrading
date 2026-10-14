#!/usr/bin/env bash
# 在一台全新的 Ubuntu 22.04 / Debian 12 服务器上执行一次（以 root 或 sudo）：
#   curl -fsSL https://raw.githubusercontent.com/<你的GitHub用户名>/dual-agent-review-loop/main/deploy/setup-server.sh | bash -s -- <你的GitHub用户名>
set -euo pipefail
GH_USER="${1:?用法: setup-server.sh <GitHub用户名>}"
REPO="dual-agent-review-loop"
APP_DIR="/srv/peergrading"

apt-get update
apt-get install -y ca-certificates curl git gnupg debian-keyring debian-archive-keyring apt-transport-https

# Docker
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# Caddy（HTTPS 反向代理，证书自动）
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

# 代码
if [ ! -d "$APP_DIR" ]; then
  git clone "https://github.com/$GH_USER/$REPO.git" "$APP_DIR"
fi
cd "$APP_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s#^BASE_URL=.*#BASE_URL=https://peergrading.ai#" .env
  sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=$(openssl rand -hex 32)#" .env
  echo ">>> 请编辑 $APP_DIR/.env：填入 GOOGLE_* / WECHAT_* / KIMI_API_KEY / 收款信息，然后再执行 deploy/deploy.sh"
fi
install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
echo ">>> 服务器准备完成。下一步：编辑 .env，然后运行 $APP_DIR/deploy/deploy.sh"
