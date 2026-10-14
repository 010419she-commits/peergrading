#!/usr/bin/env bash
# 在服务器上交互式填入 Google 登录凭证并重启：ssh root@服务器 /srv/peergrading/deploy/set-google.sh
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -p "Google Client ID: " CID
read -r -s -p "Google Client Secret（输入时不显示）: " CSEC; echo
[ -n "$CID" ] && [ -n "$CSEC" ] || { echo "两项都不能为空"; exit 1; }
sed -i "s#^GOOGLE_CLIENT_ID=.*#GOOGLE_CLIENT_ID=$CID#" .env
sed -i "s#^GOOGLE_CLIENT_SECRET=.*#GOOGLE_CLIENT_SECRET=$CSEC#" .env
docker compose up -d --force-recreate app >/dev/null 2>&1
sleep 4
curl -s http://127.0.0.1:3000/api/auth/bootstrap | grep -o '"google":{"available":[a-z]*' || true
echo; echo ">>> 已写入并重启。打开 https://peergrading.ai 点「登录」应能看到 Google 登录。"
