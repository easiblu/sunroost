#!/usr/bin/env bash
# Runs image/build.sh inside a privileged Linux container (macOS, Windows, or Linux without the tools).
#   image/build-docker.sh <rpi-arm64|rpi-armhf|orangepi3-lts> [out-dir]     (out-dir defaults to ./dist)
# Loop devices and binfmt (to run ARM binaries) need --privileged. Base images are cached in the
# Docker volume "sunroost-image-cache".
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${2:-$REPO/dist}" && cd "${2:-$REPO/dist}" && pwd)
docker build -q -t sunroost-image-builder "$REPO/image" >/dev/null
docker run --rm --privileged -v /dev:/dev -v "$REPO:/repo:ro" -v "$OUT:/out" -v sunroost-image-cache:/cache \
  -e CACHE=/cache -e VERSION -e GROW sunroost-image-builder bash -c '
    # Register qemu for foreign-architecture binaries (no-op where the CPU runs them natively).
    [ -e /proc/sys/fs/binfmt_misc/register ] || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
    update-binfmts --enable >/dev/null 2>&1 || true
    git config --global --add safe.directory /repo
    /repo/image/build.sh "$0" /out' "$1"
