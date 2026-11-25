#!/usr/bin/env bash
# Daily dump of Capsio's databases (the collaboration service and, on the same host, the forum)
# into /var/backups/capsio, keeping 14 days. File contents live in OSS and are not part of it.
# Installed as /usr/local/sbin/capsio-backup; capsio-backup.timer runs it.
set -euo pipefail
umask 077

dir=/var/backups/capsio
stamp=$(date +%Y%m%d-%H%M%S)
install -d -m 700 "$dir"
for db in capsio capsio_community; do
  if runuser -u postgres -- psql -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    runuser -u postgres -- pg_dump -Fc "$db" > "$dir/$db-$stamp.dump.part"
    mv "$dir/$db-$stamp.dump.part" "$dir/$db-$stamp.dump"
  fi
done
find "$dir" -name '*.dump' -mtime +14 -delete
