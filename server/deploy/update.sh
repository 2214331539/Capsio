#!/usr/bin/env bash
# Deploys the collaboration service from GitHub (server/ of 2214331539/Capsio) to the host, at a
# commit that is already pushed (default: origin/main). Uses key login and passwordless sudo:
#   bash server/deploy/update.sh <ssh-host> [commit=origin/main]
set -euo pipefail

host=${1:?usage: update.sh <ssh-host> [commit]}
here=$(cd "$(dirname "$0")" && pwd)
git -C "$here" fetch --quiet origin
ref=$(git -C "$here" rev-parse "${2:-origin/main}")
echo "Deploying $ref to $host..."
ssh "$host" "sudo REF=$ref bash -s" < "$here/update-remote.sh"
