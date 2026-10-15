#!/usr/bin/env bash
# 在一台全新的 Ubuntu 22.04 / Debian 12 服务器上执行一次（以 root）。仓库是私有的，服务器不拉 git，
# 先在本机把代码同步过去，再在服务器上运行本脚本：
#   rsync -az --exclude node_modules --exclude .git --exclude .env --exclude data --exclude sessions --exclude downloads \
#     --exclude release --exclude dist ./ root@<服务器IP>:/srv/peergrading/
#   ssh root@<服务器IP> bash /srv/peergrading/deploy/setup-server.sh
# （排除项和 .github/workflows/deploy.yml 里的一致；尤其不要把本机的 .env 传上去。）
# 之后的更新由 GitHub Actions 自动 rsync 并调用 deploy/deploy.sh。
set -euo pipefail
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

# 代码：由本机 rsync 过来（见文件开头），不在这里 clone
if [ ! -f "$APP_DIR/docker-compose.yml" ]; then
  echo ">>> $APP_DIR 里没有代码。请先在本机仓库目录执行：" >&2
  echo "    rsync -az --exclude node_modules --exclude .git --exclude .env --exclude data --exclude sessions --exclude downloads --exclude release --exclude dist ./ root@<服务器IP>:$APP_DIR/" >&2
  exit 1
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
