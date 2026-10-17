#!/usr/bin/env bash
# 在全新的 Ubuntu 22.04+ / Debian 12+ 服务器上以 root 或 sudo 执行一次。
# 默认使用开源仓库； forks 可把 GitHub owner 作为第一个参数传入。
set -euo pipefail
GH_OWNER="${1:-010419she-commits}"
REPO="peergrading"
APP_DIR="/srv/peergrading"

apt-get update
apt-get install -y ca-certificates curl git gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

if [ ! -d "$APP_DIR" ]; then
  git clone "https://github.com/$GH_OWNER/$REPO.git" "$APP_DIR"
fi
cd "$APP_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s#^BASE_URL=.*#BASE_URL=https://peergrading.ai#" .env
  sed -i "s#^GITHUB_REPOSITORY=.*#GITHUB_REPOSITORY=$GH_OWNER/$REPO#" .env
fi

install -m 644 deploy/Caddyfile /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
echo ">>> 服务器准备完成。站点不需要账号或支付配置；核对 .env 后运行 $APP_DIR/deploy/deploy.sh"
