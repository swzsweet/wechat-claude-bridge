#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ] || [ "$#" -gt 1 ]; then
  echo 'Usage: curl -fsSL https://raw.githubusercontent.com/swzsweet/wechat-claude-bridge/main/deploy/pve/install.sh | sh -s -- [gateway-ip]' >&2
  exit 2
fi

base=/opt/wechat-claude-bridge
releases=$base/releases
data=/var/lib/wechat-claude-bridge
env_file=/etc/wechat-claude-bridge.env
service=wechat-claude-gateway.service
source_url=https://github.com/swzsweet/wechat-claude-bridge/archive/refs/heads/main.tar.gz

for tool in curl tar sha256sum awk; do
  command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }
done

install -d -m 0755 "$base" "$releases"

case "$(uname -m)" in
  x86_64) architecture=x64 ;;
  aarch64) architecture=arm64 ;;
  *) echo 'Unsupported PVE CPU architecture.' >&2; exit 1 ;;
esac

node_staging=$(mktemp -d "$base/.node-install.XXXXXXXX")
trap 'rm -rf "$node_staging"' EXIT HUP INT TERM
node_base=https://nodejs.org/dist/latest-v24.x
curl -fsSL "$node_base/SHASUMS256.txt" -o "$node_staging/SHASUMS256.txt"
node_archive=$(awk -v arch="$architecture" '$2 ~ ("^node-v24[.][0-9]+[.][0-9]+-linux-" arch "[.]tar[.]xz$") { print $2; exit }' "$node_staging/SHASUMS256.txt")
test -n "$node_archive"
node_release=${node_archive%.tar.xz}
if [ ! -x "$base/$node_release/bin/node" ]; then
  curl -fsSL "$node_base/$node_archive" -o "$node_staging/$node_archive"
  (cd "$node_staging" && awk -v file="$node_archive" '$2 == file' SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$node_staging/$node_archive" -C "$node_staging"
  mv "$node_staging/$node_release" "$base/$node_release"
fi
ln -sfn "$base/$node_release" "$base/node.next"
mv -Tf "$base/node.next" "$base/node"
rm -rf "$node_staging"
trap - EXIT HUP INT TERM
PATH="$base/node/bin:$PATH"
export PATH

if [ ! -f "$env_file" ]; then
  if [ "$#" -ne 1 ]; then
    echo 'First install requires the PVE private IPv4 address.' >&2
    exit 2
  fi
  case "$1" in
    ''|*[!0-9.]*) echo 'Provide a private IPv4 address.' >&2; exit 2 ;;
  esac
  printf 'BRIDGE_HOST=%s\nBRIDGE_DATA=%s\n' "$1" "$data" > "$env_file"
  chmod 0644 "$env_file"
fi

if ! id wechatbridge >/dev/null 2>&1; then
  useradd --system --home "$data" --shell /usr/sbin/nologin wechatbridge
fi
install -d -o wechatbridge -g wechatbridge -m 0700 "$data"

staging=$(mktemp -d "$releases/.staging.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
curl -fsSL "$source_url" -o "$staging/source.tar.gz"
archive_hash=$(sha256sum "$staging/source.tar.gz" | awk '{ print substr($1, 1, 12) }')
install -d "$staging/source"
tar -xzf "$staging/source.tar.gz" -C "$staging/source" --strip-components=1
test -f "$staging/source/package-lock.json"
test -f "$staging/source/src/gateway.js"
test -f "$staging/source/deploy/pve/wechat-claude-gateway.service"
(cd "$staging/source" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

release="$releases/$(date -u +%Y%m%dT%H%M%SZ)-$archive_hash"
mv "$staging/source" "$release"
rm -rf "$staging"
trap - EXIT HUP INT TERM

old=$(readlink "$base/current" 2>/dev/null || true)
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
install -m 0644 "$release/deploy/pve/$service" "/etc/systemd/system/$service"
systemctl daemon-reload

if [ -n "$old" ]; then
  ln -sfn "$old" "$base/previous"
fi

if [ ! -f "$data/wechat.json" ] || [ ! -f "$data/gateway.json" ] ||
   [ ! -f "$data/bridge-token.txt" ]; then
  echo "Release installed at $release. Copy the gateway state into $data, then enable the service."
  exit 0
fi

chown -R wechatbridge:wechatbridge "$data"
chmod 0700 "$data"
find "$data" -maxdepth 1 -type f -exec chmod 0600 {} +
systemctl enable "$service" >/dev/null
if ! systemctl restart "$service"; then
  failed=1
else
  sleep 2
  gateway_host=$(awk -F= '$1 == "BRIDGE_HOST" { print $2; exit }' "$env_file")
  if systemctl is-active --quiet "$service" &&
     "$base/node/bin/node" -e 'fetch(`http://${process.argv[1]}:8765/status`, { signal: AbortSignal.timeout(3000) }).then(r => process.exit(r.status === 401 ? 0 : 1)).catch(() => process.exit(1))' "$gateway_host"; then
    failed=0
  else
    failed=1
  fi
fi
if [ "$failed" -ne 0 ]; then
  if [ -n "$old" ]; then
    ln -sfn "$old" "$base/current.next"
    mv -Tf "$base/current.next" "$base/current"
    install -m 0644 "$old/deploy/pve/$service" "/etc/systemd/system/$service"
    systemctl daemon-reload
    systemctl restart "$service" || true
  fi
  echo 'Gateway failed to start; previous release restored when available.' >&2
  exit 1
fi
echo "Gateway running from $release"
