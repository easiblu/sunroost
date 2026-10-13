#!/usr/bin/env bash
# Updates (or rolls back) the Home Assistant container Sunroost uses as its device engine.
# Installed as /usr/local/sbin/sunroost-ha-update (root-owned, so the sunroost user can't change what sudo runs).
# Run as root (Sunroost calls it through a narrowly scoped sudoers rule):
#   sunroost-ha-update <version>      e.g. 2026.11.0: pull that image, switch the service to it, restart
#   sunroost-ha-update rollback       go back to the image used before the last update
# Only plain version numbers are accepted, so the sudoers rule can't be abused to run other images.
set -euo pipefail
UNIT=/etc/systemd/system/sunroost-homeassistant.service
STATE=/var/lib/sunroost-homeassistant/.sunroost-previous-image
REPO=ghcr.io/home-assistant/home-assistant

[ -f "$UNIT" ] || { echo "Home Assistant is not installed by Sunroost ($UNIT missing)." >&2; exit 2; }
current=$(sed -n 's/^Environment=HA_IMAGE=//p' "$UNIT")

if [[ "${1:-}" == rollback ]]; then
  [ -s "$STATE" ] || { echo "No previous version to roll back to." >&2; exit 2; }
  target=$(cat "$STATE")
elif [[ "${1:-}" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}$ ]]; then
  target="$REPO:$1"
else
  echo "Usage: $0 <version like 2026.11.0> | rollback" >&2
  exit 2
fi
[[ "$target" == "$current" ]] && { echo "Already on $target."; exit 0; }

docker pull "$target"
echo "$current" > "$STATE"
sed -i "s|^Environment=HA_IMAGE=.*|Environment=HA_IMAGE=$target|; s|$current|$target|g" "$UNIT"
systemctl daemon-reload
systemctl restart sunroost-homeassistant
echo "Home Assistant now runs $target (previous: $current)."
