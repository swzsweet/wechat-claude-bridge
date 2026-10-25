#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run as root.' >&2
  exit 2
fi

base=/opt/wechat-claude-bridge
previous=$(readlink "$base/previous")
current=$(readlink "$base/current")
test -f "$previous/src/gateway.js"
ln -sfn "$previous" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
ln -sfn "$current" "$base/previous"
systemctl restart wechat-claude-gateway.service
systemctl is-active --quiet wechat-claude-gateway.service
echo "Gateway restored to $previous"
