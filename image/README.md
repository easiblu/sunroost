# SD-card images

`image/build.sh` turns a pinned base image into a ready-to-flash Sunroost image:

1. Downloads the base image (`targets.sh`: URL + SHA-256) and verifies it.
2. Grows the root partition by 2 GB, mounts it and chroots in (qemu runs foreign-architecture binaries).
3. Runs `deploy/install.sh --image`: Node, Sunroost and its dependencies, the system user, services, permissions and
   the `sunroost` hostname. Nothing is started; board-specific steps (Home Assistant on 64-bit boards with 2 GB+)
   run once at first boot (`deploy/sunroost-firstboot.service`).
4. Starts Sunroost inside the image and checks that it answers (smoke test).
5. Cleans up, zeroes free space and compresses to `sunroost-<version>-<target>.img.xz` plus a `.sha256`.

| Target | Base | Boards |
|---|---|---|
| `rpi-arm64` | Raspberry Pi OS Lite 64-bit | Pi 3, 4, 5, Zero 2 W |
| `rpi-armhf` | Raspberry Pi OS Lite 32-bit | every Pi, incl. Pi 1, 2, Zero, Zero W |
| `orangepi3-lts` | Armbian minimal | Orange Pi 3 LTS |

## Building

On Linux (as root, with `qemu-user-static binfmt-support fdisk e2fsprogs dosfstools zerofree xz-utils rsync`):

```bash
sudo VERSION=0.1.0 image/build.sh rpi-arm64
```

On macOS or Windows, with Docker:

```bash
image/build-docker.sh rpi-arm64          # output in dist/
```

Releases build all three in GitHub Actions (`.github/workflows/images.yml`) and attach them to the release. A build
takes 10–60 minutes; the 32-bit target is slowest because it runs under emulation.

To update a base image, change its URL and SHA-256 in `targets.sh` together (the checksum is published next to each
image on downloads.raspberrypi.com and dl.armbian.com).
