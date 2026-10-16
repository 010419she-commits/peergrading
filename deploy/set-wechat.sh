#!/usr/bin/env bash
# 在服务器上交互式填入微信开放平台（网站应用）凭证并重启：ssh root@服务器 /srv/peergrading/deploy/set-wechat.sh
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -p "微信开放平台 AppID（wx 开头）: " AID
read -r -s -p "微信开放平台 AppSecret（输入时不显示）: " ASEC; echo
[ -n "$AID" ] && [ -n "$ASEC" ] || { echo "两项都不能为空"; exit 1; }
grep -q '^WECHAT_OPEN_APPID=' .env || printf 'WECHAT_OPEN_APPID=\nWECHAT_OPEN_SECRET=\n' >> .env
sed -i "s#^WECHAT_OPEN_APPID=.*#WECHAT_OPEN_APPID=$AID#" .env
sed -i "s#^WECHAT_OPEN_SECRET=.*#WECHAT_OPEN_SECRET=$ASEC#" .env
docker compose up -d --force-recreate app >/dev/null 2>&1
sleep 4
curl -s http://127.0.0.1:3000/api/auth/bootstrap | grep -o '"wechat":{"available":[a-z]*' || true
echo; echo ">>> 已写入并重启。打开 https://peergrading.ai 点「登录」应能看到「微信扫码登录」。开放平台后台的「授权回调域」须为 peergrading.ai。"
