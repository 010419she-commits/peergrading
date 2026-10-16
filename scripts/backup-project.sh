#!/usr/bin/env bash
set -euo pipefail
umask 077

# 私人换机归档：保留 Git 历史和本地配置，绝不能上传到公开仓库。
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
project_parent="$(dirname -- "$project_dir")"
project_name="$(basename -- "$project_dir")"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' '用法：bash scripts/backup-project.sh [工程目录之外的目标目录]' \
    '默认保存到 migration/backups/。请先关闭本地应用和开发服务。' \
    '归档含 Git、本地配置、密钥和数据（如存在），仅供私人迁移，不能上传 GitHub。'
  exit 0
fi
if (( $# > 1 )); then
  printf '%s\n' '只接受一个可选的目标目录。' >&2
  exit 1
fi

default_dir="$project_dir/migration/backups"
mkdir -p -- "$default_dir"
output_dir="${1:-$default_dir}"
mkdir -p -- "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd -P)"
case "$output_dir" in
  "$default_dir") ;;
  "$project_dir"|"$project_dir"/*)
    printf '%s\n' '自定义目标必须在工程之外；也可以省略参数使用 migration/backups/。' >&2
    exit 1
    ;;
esac

archive="$output_dir/peergrading-$(date '+%Y%m%d-%H%M%S')-$$.tar.gz"
partial="$(mktemp "$output_dir/.peergrading-archive.XXXXXX")"

printf '%s\n' '正在创建私人换机归档（包含现有配置、密钥与数据，请勿公开）……'
COPYFILE_DISABLE=1 tar -czf "$partial" \
  --exclude='node_modules' \
  --exclude='.DS_Store' \
  --exclude="$project_name/migration/backups" \
  --exclude="$project_name/release/*unpacked" \
  --exclude="$project_name/release/mac" \
  --exclude="$project_name/release/mac-arm64" \
  --exclude="$project_name/release/.icon-icns" \
  --exclude="$project_name/release/.icon-ico" \
  -C "$project_parent" "$project_name"
mv -- "$partial" "$archive"
printf '已生成：%s\n' "$archive"
printf '%s\n' '请私下传输；解压后执行 npm ci，再重新登录本机 Agent。'
