# Build environment for image/build.sh on macOS or Windows (see image/build-docker.sh).
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl xz-utils fdisk e2fsprogs dosfstools zerofree rsync git python3 \
      qemu-user-static binfmt-support util-linux mount \
    && rm -rf /var/lib/apt/lists/*
