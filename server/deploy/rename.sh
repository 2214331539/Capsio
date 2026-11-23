#!/usr/bin/env bash
# One-time: moves the running service from its Scientify names to Capsio's and installs the
# current code (rename-remote.sh does the work on the host). Afterwards use update.sh.
#   bash server/deploy/rename.sh [ssh-host]      (default: your-host)
set -euo pipefail

host=${1:-your-host}
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

tar -czf "$work/capsio-collab-src.tgz" -C "$here" src admin package.json
cp "$here/deploy/capsio-collab.service" "$work/"
cp "$here/deploy/rename-remote.sh" "$work/capsio-collab-rename-remote.sh"
echo "Uploading to $host..."
scp "$work/capsio-collab-src.tgz" "$work/capsio-collab.service" \
  "$work/capsio-collab-rename-remote.sh" "$host:/tmp/"
echo "Renaming on $host (sudo will ask for the password)..."
ssh -t "$host" "sudo bash /tmp/capsio-collab-rename-remote.sh"
