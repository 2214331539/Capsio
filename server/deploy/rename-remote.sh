#!/usr/bin/env bash
# One-time move of the collaboration service from its Scientify names to Capsio's: service,
# system user, directories, environment file, database and role, Nginx files, plus the new code.
# Runs on the host as root; rename.sh uploads it. Everything is backed up first, and if the
# renamed service does not come up healthy the Scientify names are put back.
set -euo pipefail

stamp=$(date +%Y%m%d-%H%M%S)
backup=/root/backups/capsio-rename-$stamp
upload=/tmp/capsio-collab-src.tgz
unit=/tmp/capsio-collab.service

if [ -e /etc/systemd/system/capsio-collab.service ]; then
  echo "Already renamed; use update.sh for new code."
  exit 0
fi

mkdir -p "$backup"
tar -czf "$backup/scientify-collab.tgz" -C /opt scientify-collab
cp -a /etc/scientify-collab.env /etc/systemd/system/scientify-collab.service \
  /etc/nginx/conf.d/scientify.conf /etc/nginx/conf.d/scientify-limits.conf \
  /etc/nginx/snippets/scientify-proxy.conf "$backup/"
runuser -u postgres -- pg_dump -Fc scientify > "$backup/scientify.dump"
echo "Backed up to $backup"

sql() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -qc "$1"; }
exists() { runuser -u postgres -- psql -tAc "$1" | grep -q 1; }
healthy() {
  for _ in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:8081/v1/health > /dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

restore() {
  trap - ERR
  set +e
  echo "Putting the Scientify names back." >&2
  journalctl -u capsio-collab -n 30 --no-pager >&2 || true
  systemctl disable --now capsio-collab 2>/dev/null || true
  rm -f /etc/systemd/system/capsio-collab.service /etc/capsio-collab.env
  rm -rf /opt/capsio-collab /opt/scientify-collab
  tar -xzf "$backup/scientify-collab.tgz" -C /opt
  if [ -d /var/lib/capsio-collab ]; then mv /var/lib/capsio-collab /var/lib/scientify-collab; fi
  if getent passwd capsio > /dev/null; then usermod -l scientify -d /opt/scientify-collab capsio; fi
  if getent group capsio > /dev/null; then groupmod -n scientify capsio; fi
  if exists "SELECT 1 FROM pg_database WHERE datname = 'capsio'"; then
    sql 'ALTER DATABASE capsio RENAME TO scientify'
  fi
  if exists "SELECT 1 FROM pg_roles WHERE rolname = 'capsio_app'"; then
    sql 'ALTER ROLE capsio_app RENAME TO scientify_app'
  fi
  cp -a "$backup/scientify-collab.env" /etc/
  cp -a "$backup/scientify-collab.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now scientify-collab
  healthy && echo "Scientify service restored." >&2
  exit 1
}
trap restore ERR

systemctl disable --now scientify-collab
sql 'ALTER DATABASE scientify RENAME TO capsio'
# SCRAM passwords survive a role rename (MD5 ones would not).
sql 'ALTER ROLE scientify_app RENAME TO capsio_app'
usermod -l capsio -d /opt/capsio-collab scientify
groupmod -n capsio scientify
mv /opt/scientify-collab /opt/capsio-collab
if [ -d /var/lib/scientify-collab ]; then mv /var/lib/scientify-collab /var/lib/capsio-collab; fi

sed -E \
  -e 's#^(DATABASE_URL=postgresql://)scientify_app:#\1capsio_app:#' \
  -e 's#^(DATABASE_URL=.*/)scientify$#\1capsio#' \
  -e 's#^JWT_ISSUER=scientify-collaboration$#JWT_ISSUER=capsio-collaboration#' \
  /etc/scientify-collab.env > /etc/capsio-collab.env
chown --reference=/etc/scientify-collab.env /etc/capsio-collab.env
chmod --reference=/etc/scientify-collab.env /etc/capsio-collab.env
grep -qE '^DATABASE_URL=postgresql://capsio_app:.*/capsio$' /etc/capsio-collab.env
rm /etc/scientify-collab.env /etc/systemd/system/scientify-collab.service
install -m 644 "$unit" /etc/systemd/system/capsio-collab.service

tar -xzf "$upload" -C /opt/capsio-collab/server
chown -R root:root /opt/capsio-collab/server
systemctl daemon-reload
systemctl enable --now capsio-collab
healthy || restore
trap - ERR
echo "Service: $(curl -fsS http://127.0.0.1:8081/v1/health)"

# Nginx: the same server block and limits under the new names.
nginx_conf=/etc/nginx/conf.d
sed -e 's/scientify_codes/capsio_codes/g; s/scientify_api/capsio_api/g' \
  -e 's#snippets/scientify-proxy.conf#snippets/capsio-proxy.conf#g' \
  -e 's/scientify-collab.service/capsio-collab.service/g; s/scientify-8443.conf/capsio-8443.conf/g' \
  -e 's/Scientify/Capsio/g' \
  "$nginx_conf/scientify.conf" > "$nginx_conf/capsio.conf"
sed -e 's/scientify_/capsio_/g; s/scientify-limits/capsio-limits/g' \
  "$nginx_conf/scientify-limits.conf" > "$nginx_conf/capsio-limits.conf"
sed -e 's/scientify/capsio/g; s/Scientify/Capsio/g' /etc/nginx/snippets/scientify-proxy.conf \
  > /etc/nginx/snippets/capsio-proxy.conf
mv "$nginx_conf/scientify.conf" "$nginx_conf/scientify-limits.conf" "$backup/" 2> /dev/null || true
if nginx -t 2> "$backup/nginx-test.log"; then
  systemctl reload nginx
  if ! grep -rqs scientify-proxy.conf /etc/nginx/conf.d /etc/nginx/snippets /etc/nginx/sites-enabled; then
    rm /etc/nginx/snippets/scientify-proxy.conf
  fi
  echo "Nginx: $(curl -ksS https://127.0.0.1:8443/v1/health)"
else
  cat "$backup/nginx-test.log" >&2
  rm -f "$nginx_conf/capsio.conf" "$nginx_conf/capsio-limits.conf" /etc/nginx/snippets/capsio-proxy.conf
  cp -a "$backup/scientify.conf" "$backup/scientify-limits.conf" "$nginx_conf/"
  echo "Nginx kept its Scientify files; the service itself is renamed and healthy." >&2
fi

runuser -u postgres -- psql -d capsio -tAc \
  "SELECT 'migrations: ' || string_agg(id || ' ' || name, ', ') FROM schema_migrations"
rm -f "$upload" "$unit" /tmp/capsio-collab-rename-remote.sh
echo "Done. Backups in $backup"
