#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 || ! -c /dev/tty ]]; then
  echo 'Run this script as root in an interactive PVE terminal.' >&2
  exit 2
fi

IFS= read -r -s -p 'Telegram Bot Token: ' bot_token < /dev/tty
printf '\n' > /dev/tty
if [[ ! $bot_token =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  unset bot_token
  echo 'Invalid Bot Token format. The existing gateway configuration was not changed.' >&2
  exit 2
fi

data=/var/lib/wechat-claude-bridge
temp=$(mktemp "$data/.telegram-token.XXXXXXXX")
trap 'rm -f "$temp"' EXIT
printf '%s' "$bot_token" > "$temp"
unset bot_token
chown wechatbridge:wechatbridge "$temp"
chmod 0600 "$temp"
mv -f "$temp" "$data/telegram-token.txt"
trap - EXIT

systemctl restart wechat-claude-gateway.service
sleep 2
systemctl is-active --quiet wechat-claude-gateway.service
echo 'Telegram token saved and gateway restarted. Check the journal for the /bind command.'
