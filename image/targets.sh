# Base images, pinned by version and SHA-256. Update both together; image/build.sh refuses a mismatch.
# shellcheck disable=SC2034
case "$TARGET" in
  rpi-arm64)
    # Raspberry Pi 3, 4, 5, Zero 2 W (64-bit Raspberry Pi OS Lite).
    BASE_URL=https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-10-06/2026-10-06-raspios-trixie-arm64-lite.img.xz
    BASE_SHA256=483db18a48da399b5b7022ffae9a07bc6d99daab30e593aedac09b69ff422843
    ARCH=arm64; BOOT_PART=1; ROOT_PART=2; BOOT_MOUNT=boot/firmware ;;
  rpi-armhf)
    # Every Raspberry Pi, including Pi 1, Pi 2, Zero and Zero W (32-bit Raspberry Pi OS Lite).
    BASE_URL=https://downloads.raspberrypi.com/raspios_lite_armhf/images/raspios_lite_armhf-2026-10-06/2026-10-06-raspios-trixie-armhf-lite.img.xz
    BASE_SHA256=2c302771f34c67a0b7ae7aa2e0dcdd3eac660504be59193c011ba79d412e1632
    ARCH=armhf; BOOT_PART=1; ROOT_PART=2; BOOT_MOUNT=boot/firmware ;;
  orangepi3-lts)
    # Orange Pi 3 LTS (Armbian minimal, Debian Trixie; one partition, /boot inside it).
    BASE_URL=https://dl.armbian.com/orangepi3-lts/archive/Armbian_26.8.2_Orangepi3-lts_trixie_current_6.18.44_minimal.img.xz
    BASE_SHA256=00807af5fbbd160ccd238b049f34c899aa7fc4fc6885ad92151574797ed90ad9
    ARCH=arm64; BOOT_PART=; ROOT_PART=1; BOOT_MOUNT= ;;
  *) echo "Unknown target '$TARGET'. Targets: rpi-arm64 rpi-armhf orangepi3-lts" >&2; exit 1 ;;
esac
