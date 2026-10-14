#!/usr/bin/env bash
# 把本地打包好的安装包上传到网站的下载目录：deploy/upload-release.sh root@服务器IP
set -euo pipefail
HOST="${1:?用法: upload-release.sh <user@host>}"
ssh "$HOST" "mkdir -p /srv/peergrading/downloads"
scp release/*.dmg release/*.exe "$HOST:/srv/peergrading/downloads/" 2>/dev/null || scp release/*.dmg "$HOST:/srv/peergrading/downloads/"
echo ">>> 已上传，网站的「下载」区会自动显示最新版本"
