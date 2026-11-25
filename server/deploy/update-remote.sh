#!/usr/bin/env bash
# Runs on the host as root; update.sh starts it. Installs or updates the collaboration service from
# GitHub at $REF: Node 22 beside the service, server/ with its dependency from the lockfile, the
# systemd unit and the daily database backup. Backs up the current code and database first and
# rolls back if the new version is unhealthy. /etc/capsio-collab.env and the database must exist
# (DEPLOYMENT.md, sections 2 and 3).
set -euo pipefail
: "${REF:?REF, a pushed commit, is required}"

repo=https://github.com/2214331539/Capsio.git
base=/opt/capsio-collab
app=$base/server
node=$base/node
stamp=$(date +%Y%m%d-%H%M%S)
backup=/root/backups/capsio-collab-$stamp
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

test -f /etc/capsio-collab.env || { echo "/etc/capsio-collab.env is missing" >&2; exit 1; }
id capsio >/dev/null 2>&1 || useradd --system --home-dir "$base" --shell /usr/sbin/nologin capsio

if [ ! -x "$node/bin/node" ]; then
  dist=https://nodejs.org/dist/latest-v22.x
  sums=$(curl -fsSL "$dist/SHASUMS256.txt")
  file=$(awk '/linux-x64\.tar\.xz$/ {print $2}' <<<"$sums")
  curl -fsSL "$dist/$file" -o "$work/$file"
  (cd "$work" && grep " $file\$" <<<"$sums" | sha256sum -c - >/dev/null)
  mkdir -p "$node"
  tar -xJf "$work/$file" -C "$node" --strip-components=1
fi
export PATH="$node/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# server/ at $REF, with its dependency installed from the lockfile.
git clone --quiet --filter=blob:none --no-checkout "$repo" "$work/repo"
git -C "$work/repo" sparse-checkout set server
git -C "$work/repo" checkout --quiet "$REF"
source=$work/repo/server
(cd "$source" && corepack pnpm install --prod --frozen-lockfile --ignore-workspace \
  --config.node-linker=hoisted --reporter=silent)
rm -rf "$base/server.next"
mkdir -p "$base/server.next"
cp -a "$source"/{package.json,pnpm-lock.yaml,src,admin,node_modules} "$base/server.next/"
echo "$REF" > "$base/server.next/REVISION"
chown -R root:root "$base/server.next"

if [ -d "$app" ]; then
  mkdir -p "$backup"
  tar -czf "$backup/server.tgz" -C "$base" server
  runuser -u postgres -- pg_dump -Fc capsio > "$backup/capsio.dump"
  echo "Backed up code and database to $backup"
fi

install -m 644 "$source/deploy/capsio-collab.service" "$source/deploy/capsio-backup.service" \
  "$source/deploy/capsio-backup.timer" /etc/systemd/system/
install -m 755 "$source/deploy/capsio-backup.sh" /usr/local/sbin/capsio-backup
systemctl daemon-reload
systemctl enable --quiet capsio-collab
systemctl enable --quiet --now capsio-backup.timer

healthy() {
  for _ in $(seq 1 15); do
    if curl -fsS http://127.0.0.1:8081/v1/health > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

rm -rf "$base/server.previous"
[ -d "$app" ] && mv "$app" "$base/server.previous"
mv "$base/server.next" "$app"
systemctl restart capsio-collab
if ! healthy; then
  echo "The new version did not become healthy." >&2
  journalctl -u capsio-collab -n 30 --no-pager >&2 || true
  if [ -d "$base/server.previous" ]; then
    rm -rf "$app"
    mv "$base/server.previous" "$app"
    systemctl restart capsio-collab
    healthy && echo "Previous version restored." >&2
  fi
  exit 1
fi

echo "Health: $(curl -fsS http://127.0.0.1:8081/v1/health)"
# The admin pages answer, and their API refuses a call without a session.
echo "Admin pages: HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/admin/) (200 expected)"
echo "Admin API without a session: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H 'x-capsio-admin: 1' http://127.0.0.1:8081/admin/api/me) (401 expected)"
runuser -u postgres -- psql -d capsio -tAc \
  "SELECT 'migrations: ' || string_agg(id || ' ' || name, ', ') FROM schema_migrations"
runuser -u postgres -- psql -d capsio -tAc \
  "SELECT 'channels: ' || count(*) || ', listed models: ' || (SELECT count(*) FROM models WHERE active) FROM channels"
echo "Done at $REF."
[ -d "$base/server.previous" ] &&
  echo "Rollback: rm -rf $app && mv $base/server.previous $app && systemctl restart capsio-collab"
exit 0
