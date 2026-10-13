#!/usr/bin/env bash
# Builds a ready-to-flash Sunroost SD-card image: a pinned Raspberry Pi OS / Armbian base image with
# Sunroost installed (deploy/install.sh --image), smoke-tested, then compressed.
#
#   sudo image/build.sh <target> [out-dir]      targets: rpi-arm64 rpi-armhf orangepi3-lts
#
# Runs as root on Linux (a GitHub runner, or image/build-docker.sh on macOS/Windows). Other-architecture
# targets need qemu-user-static with binfmt (qemu-arm for armhf on an arm64 or x86 host).
# Output: <out-dir>/sunroost-<version>-<target>.img.xz and .sha256 (out-dir defaults to dist/).
set -euo pipefail
TARGET=${1:?usage: image/build.sh <rpi-arm64|rpi-armhf|orangepi3-lts> [out-dir]}
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${2:-$REPO/dist}" && cd "${2:-$REPO/dist}" && pwd)
CACHE=${CACHE:-$REPO/.image-cache}
GROW=${GROW:-2G}
VERSION=${VERSION:-$(node -p 'require(process.argv[1]).version' "$REPO/package.json" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json")}
# shellcheck source=image/targets.sh
source "$REPO/image/targets.sh"
[[ $EUID == 0 ]] || { echo "Run as root (it mounts the image)." >&2; exit 1; }

WORK=$(mktemp -d /tmp/sunroost-image.XXXXXX)
ROOT=$WORK/root
LOOPS=()
cleanup() {
  set +e
  for m in dev/pts dev proc sys $BOOT_MOUNT; do mountpoint -q "$ROOT/$m" && umount -l "$ROOT/$m"; done
  mountpoint -q "$ROOT" && umount -l "$ROOT"
  for l in "${LOOPS[@]}"; do losetup -d "$l"; done
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { echo; echo "==> $*"; }

step "Base image ($TARGET)"
mkdir -p "$CACHE"
BASE=$CACHE/$(basename "$BASE_URL")
if [[ ! -f $BASE ]]; then curl -fL --retry 3 -o "$BASE.part" "$BASE_URL" && mv "$BASE.part" "$BASE"; fi
echo "$BASE_SHA256  $BASE" | sha256sum -c -
IMG=$WORK/sunroost.img
xz -dc "$BASE" > "$IMG"

step "Grow the root partition by $GROW"
truncate -s +"$GROW" "$IMG"
echo ", +" | sfdisk -N "$ROOT_PART" --no-reread "$IMG"
part_offset() { sfdisk -J "$IMG" | python3 -c "import json,sys; p=json.load(sys.stdin)['partitiontable']; print(p['partitions'][int(sys.argv[1])-1]['start'] * p.get('sectorsize', 512))" "$1"; }
part_size() { sfdisk -J "$IMG" | python3 -c "import json,sys; p=json.load(sys.stdin)['partitiontable']; print(p['partitions'][int(sys.argv[1])-1]['size'] * p.get('sectorsize', 512))" "$1"; }
attach() { local l; l=$(losetup -f --show -o "$(part_offset "$1")" --sizelimit "$(part_size "$1")" "$IMG"); LOOPS+=("$l"); echo "$l"; }
ROOT_DEV=$(attach "$ROOT_PART")
e2fsck -fy "$ROOT_DEV" || [[ $? -le 1 ]]
resize2fs "$ROOT_DEV"

step "Mount"
mkdir -p "$ROOT"
mount "$ROOT_DEV" "$ROOT"
if [[ -n $BOOT_PART ]]; then BOOT_DEV=$(attach "$BOOT_PART"); mount "$BOOT_DEV" "$ROOT/$BOOT_MOUNT"; fi
mount -t proc proc "$ROOT/proc"
mount -t sysfs sys "$ROOT/sys"
mount --bind /dev "$ROOT/dev"
mount --bind /dev/pts "$ROOT/dev/pts"
# Name resolution inside the chroot; the image's own resolv.conf is restored afterwards.
mv "$ROOT/etc/resolv.conf" "$WORK/resolv.conf.orig" 2>/dev/null || true
cp /etc/resolv.conf "$ROOT/etc/resolv.conf"
# Don't let package installs start services inside the chroot.
printf '#!/bin/sh\nexit 101\n' > "$ROOT/usr/sbin/policy-rc.d"; chmod +x "$ROOT/usr/sbin/policy-rc.d"

step "Copy Sunroost"
SRC=$ROOT/tmp/sunroost-src
mkdir -p "$SRC"
if git -C "$REPO" rev-parse >/dev/null 2>&1; then
  git -C "$REPO" ls-files -z | rsync -a --from0 --files-from=- "$REPO/" "$SRC/"
else
  rsync -a --exclude node_modules --exclude data --exclude dist --exclude .image-cache --exclude .git "$REPO/" "$SRC/"
fi

step "Install (deploy/install.sh --image)"
chroot "$ROOT" /bin/bash -c "cd /tmp/sunroost-src && DEBIAN_FRONTEND=noninteractive deploy/install.sh --image"

step "Smoke test: start Sunroost in the image and query it"
chroot "$ROOT" /bin/bash -c '
  set -e
  mkdir -p /tmp/smoke && chown sunroost:sunroost /tmp/smoke
  NODE=$(command -v node)
  runuser -u sunroost -- env SOLAR_DATA=/tmp/smoke SOLAR_HOST=127.0.0.1 SOLAR_PORT=18080 SOLAR_CONFIG=/none SOLAR_MQTT_PORT=18830 \
    "$NODE" --disable-warning=ExperimentalWarning /opt/sunroost/src/index.ts > /tmp/smoke/log 2>&1 &
  PID=$!
  ok=0
  for i in $(seq 1 180); do
    if curl -fsS http://127.0.0.1:18080/api/devices/status > /tmp/smoke/status 2>/dev/null; then ok=1; break; fi
    kill -0 $PID 2>/dev/null || break
    sleep 1
  done
  kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true
  if [ $ok = 1 ]; then echo "OK after ${i}s: $(cat /tmp/smoke/status)"; else echo "Sunroost did not answer:"; tail -40 /tmp/smoke/log; exit 1; fi
  # The serial-port list loads the native serialport binding for this architecture.
  runuser -u sunroost -- "$NODE" -e "import(\"/opt/sunroost/node_modules/serialport/dist/index.js\").then(m => m.SerialPort.list()).then(p => console.log(\"serialport OK:\", p.length, \"ports\")).catch(e => { console.error(\"serialport FAILED:\", e.message); process.exit(1); })"
  rm -rf /tmp/smoke
'

step "Clean up"
chroot "$ROOT" /bin/bash -c 'apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/sunroost-src /root/.npm /opt/sunroost/.npm'
rm -f "$ROOT/usr/sbin/policy-rc.d" "$ROOT/etc/resolv.conf"
[[ -e $WORK/resolv.conf.orig || -L $WORK/resolv.conf.orig ]] && mv "$WORK/resolv.conf.orig" "$ROOT/etc/resolv.conf"
for m in dev/pts dev proc sys $BOOT_MOUNT; do umount "$ROOT/$m"; done
umount "$ROOT"
# Zero the free space so the image compresses well.
command -v zerofree >/dev/null && zerofree "$ROOT_DEV"
for l in "${LOOPS[@]}"; do losetup -d "$l"; done; LOOPS=()

step "Compress"
NAME=sunroost-$VERSION-$TARGET.img.xz
xz -T0 -6 -c "$IMG" > "$OUT/$NAME"
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256")
ls -lh "$OUT/$NAME"
echo "Done: $OUT/$NAME"
