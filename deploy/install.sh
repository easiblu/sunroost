#!/usr/bin/env bash
# Installs Sunroost. Run from the repo root: sudo deploy/install.sh [--kiosk] [--home-assistant | --no-home-assistant]
#   --image               (used by image/build.sh) install into an SD-card image being built in a chroot: nothing is
#                         started, board-specific steps (Home Assistant) are left to the first boot.
#   --firstboot           (run once by sunroost-firstboot.service on the board) the board-specific steps.
# Supported boards: Raspberry Pi 1, 2, 3, 4, 5, Zero, Zero W and Zero 2 W (Raspberry Pi OS Bookworm or newer,
# 32- or 64-bit), and Orange Pi 3 LTS (Debian or Armbian, 64-bit).
#   --kiosk               also installs cage + chromium so the dashboard can run on an HDMI screen (1 GB of RAM or more).
#   --home-assistant      install Home Assistant (every integration) even on a 1 GB board.
#   --no-home-assistant   don't install it. By default it is installed on 64-bit boards with 2 GB of RAM or more.
set -euo pipefail
KIOSK=0
HA_MODE=auto
MODE=normal
for arg in "$@"; do
  case "$arg" in
    --kiosk) KIOSK=1 ;;
    --home-assistant) HA_MODE=yes ;;
    --no-home-assistant) HA_MODE=no ;;
    --image) MODE=image ;;
    --firstboot) MODE=firstboot ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
# The Home Assistant release Sunroost was tested with; override with HA_IMAGE=… to change it.
HA_IMAGE=${HA_IMAGE:-ghcr.io/home-assistant/home-assistant:2026.10.1}

# 64-bit boards get Node 24 LTS (supported to 2028). 32-bit ARM only has builds up to Node 22 LTS
# (supported to April 2027; ARMv6 builds come from Node's unofficial-builds project). Sunroost targets
# Node 22's APIs so it runs on both.
NODE_24=24.21.0
NODE_22=22.23.3

MODEL=$(tr -d '\0' 2>/dev/null </proc/device-tree/model || echo "unknown board")
[[ $MODE == image ]] && MODEL="SD-card image"
RAM_MB=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
# The OS userland decides which binaries run: a 32-bit OS on a Pi 4 still has a 64-bit kernel.
# Pi 1 and Zero report "CPU architecture: 7" in /proc/cpuinfo, so tell ARMv6 apart by `uname -m`.
case "$(dpkg --print-architecture)" in
  arm64) NODE_ARCH=arm64 ;;
  # A 32-bit image must also boot on ARMv6 (Pi 1 / Zero), whose binaries run on ARMv7 too.
  armhf) if [[ $MODE == image || "$(uname -m)" == armv6l ]]; then NODE_ARCH=armv6l; else NODE_ARCH=armv7l; fi ;;
  amd64) NODE_ARCH=x64 ;;
  *) echo "Unsupported OS architecture: $(dpkg --print-architecture)" >&2; exit 1 ;;
esac

case "$MODEL" in
  *"Raspberry Pi"* | *"OrangePi 3 LTS"* | *"Orange Pi 3 LTS"* | "SD-card image") ;;
  *) echo "Warning: \"$MODEL\" is not a supported board (Raspberry Pi 1-5, Zero, Zero 2 W, Orange Pi 3 LTS). Continuing." ;;
esac
echo "Installing Sunroost on $MODEL ($NODE_ARCH, ${RAM_MB} MB RAM)."

if [[ $KIOSK == 1 && ( $NODE_ARCH == armv6l || $RAM_MB -lt 700 ) ]]; then
  echo "Skipping --kiosk: the HDMI dashboard needs a board with 1 GB of RAM or more. Open the web UI from any browser instead."
  KIOSK=0
fi

# ---- Home Assistant: the full device engine (every integration) ----
install_home_assistant() {
# Needs a 64-bit OS; 2 GB of RAM (1 GB with --home-assistant, tight) and ~6 GB of free disk.
INSTALL_HA=0
HA_SKIP=""
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
if [[ $HA_MODE == no ]]; then
  HA_SKIP="--no-home-assistant was given"
elif [[ $NODE_ARCH != arm64 && $NODE_ARCH != x64 ]]; then
  HA_SKIP="it needs a 64-bit OS (this one is $NODE_ARCH)"
elif [[ $HA_MODE != yes && $RAM_MB -lt 1500 ]]; then
  HA_SKIP="it needs 2 GB of RAM (this board has ${RAM_MB} MB; use --home-assistant to install it anyway)"
elif [[ $FREE_GB -lt 6 ]]; then
  HA_SKIP="it needs about 6 GB of free disk space (${FREE_GB} GB free)"
else
  INSTALL_HA=1
fi
if [[ $INSTALL_HA == 1 ]]; then
  echo "Installing Home Assistant ($HA_IMAGE) as Sunroost's device engine…"
  command -v docker >/dev/null || { apt-get update && apt-get install -y docker.io; }
  systemctl enable --now docker
  mkdir -p /var/lib/sunroost-homeassistant
  [ -f /var/lib/sunroost-homeassistant/configuration.yaml ] || cp deploy/homeassistant/configuration.yaml /var/lib/sunroost-homeassistant/configuration.yaml
  docker pull "$HA_IMAGE"
  # Leave Sunroost at least ~45% of the RAM.
  sed -e "s|@HA_IMAGE@|$HA_IMAGE|" -e "s|@HA_MEMORY@|$((RAM_MB * 55 / 100))m|" deploy/sunroost-homeassistant.service > /etc/systemd/system/sunroost-homeassistant.service
  # The update script runs as root through sudo, so it must not be writable by the sunroost user:
  # a root-owned copy outside /opt/sunroost.
  install -o root -g root -m 0755 deploy/ha-update.sh /usr/local/sbin/sunroost-ha-update
else
  echo "Not installing Home Assistant: $HA_SKIP. Sunroost's built-in device drivers are used instead."
fi
}

if [[ $MODE == firstboot ]]; then
  # On the board, once: the Home Assistant decision needs the real RAM and disk size.
  install_home_assistant
  systemctl daemon-reload
  [[ $INSTALL_HA == 1 ]] && systemctl enable --now sunroost-homeassistant
  systemctl disable sunroost-firstboot.service || true
  echo "First-boot setup done."
  exit 0
fi

apt-get update
# libatomic1: Node's 32-bit ARM builds link against it, and minimal images don't always ship it.
apt-get install -y curl ca-certificates xz-utils libatomic1 rsync uhubctl can-utils
# Images: WiFi setup and the hotspot need NetworkManager, and sunroost.local needs avahi (Armbian minimal lacks both).
[[ $MODE == image ]] && apt-get install -y network-manager avahi-daemon
[[ $MODE == image ]] && KIOSK=0 # the kiosk is a per-board choice (re-run the installer with --kiosk)
[[ $KIOSK == 1 ]] && apt-get install -y cage chromium

node_ok() {
  command -v node >/dev/null &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'
}
if [[ $NODE_ARCH == arm64 || $NODE_ARCH == x64 ]]; then NODE_VERSION=$NODE_24; else NODE_VERSION=$NODE_22; fi
if ! node_ok; then
  if [[ $NODE_ARCH == armv6l ]]; then BASE=https://unofficial-builds.nodejs.org/download/release; else BASE=https://nodejs.org/dist; fi
  NAME=node-v$NODE_VERSION-linux-$NODE_ARCH
  TMP=$(mktemp -d)
  curl -fsSL "$BASE/v$NODE_VERSION/$NAME.tar.xz" -o "$TMP/$NAME.tar.xz"
  curl -fsSL "$BASE/v$NODE_VERSION/SHASUMS256.txt" | grep " $NAME.tar.xz\$" | (cd "$TMP" && sha256sum -c -)
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$TMP/$NAME.tar.xz" -C /usr/local/lib/nodejs
  ln -sf "/usr/local/lib/nodejs/$NAME/bin/node" "/usr/local/lib/nodejs/$NAME/bin/npm" "/usr/local/lib/nodejs/$NAME/bin/npx" /usr/local/bin/
  rm -rf "$TMP"
  hash -r
fi
NODE_BIN=$(command -v node)
NODE_V=$(node -v) # fails the install here if Node can't run on this board
echo "Using Node $NODE_V at $NODE_BIN."

# cloudflared, for optional remote access on your own domain (Cloudflare's official apt repository).
# Cloudflare's ARM builds need ARMv7, so Pi 1 and Zero use the reverse-proxy or DDNS options instead.
if [[ $NODE_ARCH == armv6l ]]; then
  echo "Skipping cloudflared: there is no build for this board. Remote access can use your own reverse proxy instead."
elif ! command -v cloudflared >/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi

id sunroost >/dev/null 2>&1 || useradd --system --home /opt/sunroost --shell /usr/sbin/nologin sunroost
# sunroost.service needs dialout and netdev; the others exist only on some images (Armbian has no "render" on older kernels).
getent group netdev >/dev/null || groupadd --system netdev
SOLAR_GROUPS=$(for g in dialout netdev video input render; do getent group "$g" >/dev/null && printf '%s,' "$g"; done)
usermod -aG "${SOLAR_GROUPS%,}" sunroost

mkdir -p /opt/sunroost
rsync -a --delete --exclude node_modules --exclude data --exclude config.json --exclude .git ./ /opt/sunroost/
# Serve on port 80 (the URL users type has no port, and the hotspot's captive portal needs it).
# Real installs start with no inverter selected (the simulator is the default only for development).
[ -f /opt/sunroost/config.json ] || echo '{ "http": { "host": "0.0.0.0", "port": 80 }, "dataDir": "data", "initialSettings": { "inverter.driver_id": "" } }' > /opt/sunroost/config.json
cd /opt/sunroost && npm ci --omit=dev
mkdir -p /opt/sunroost/data && chown -R sunroost:sunroost /opt/sunroost

sed "s|/usr/bin/node|$NODE_BIN|" deploy/sunroost.service > /etc/systemd/system/sunroost.service
cp deploy/sunroost-kiosk.service /etc/systemd/system/sunroost-kiosk.service

INSTALL_HA=0
if [[ $MODE == image ]]; then
  # Docker can't run inside the image chroot, and the board's RAM isn't known yet: install the tools
  # now (64-bit only) and let the first boot decide and pull the Home Assistant image.
  if [[ $NODE_ARCH == arm64 && $HA_MODE != no ]]; then
    apt-get install -y docker.io
    systemctl enable docker
    install -o root -g root -m 0755 deploy/ha-update.sh /usr/local/sbin/sunroost-ha-update
  fi
  cp deploy/sunroost-firstboot.service /etc/systemd/system/sunroost-firstboot.service
  systemctl enable sunroost-firstboot
else
  install_home_assistant
fi

# ---- Permissions for the Configuration pages (scoped; nothing else is granted) ----
mkdir -p /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/50-sunroost.rules <<'RULES'
// Lets the Sunroost app manage WiFi, time, power and three specific services.
polkit.addRule(function (action, subject) {
  if (subject.user != "sunroost") return;
  if (action.id.indexOf("org.freedesktop.NetworkManager.") == 0) return polkit.Result.YES;
  if (action.id.indexOf("org.freedesktop.timedate1.") == 0) return polkit.Result.YES;
  if (["org.freedesktop.login1.reboot", "org.freedesktop.login1.reboot-multiple-sessions",
       "org.freedesktop.login1.power-off", "org.freedesktop.login1.power-off-multiple-sessions"].indexOf(action.id) >= 0) {
    return polkit.Result.YES;
  }
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      ["ssh.service", "bluetooth.service", "sunroost-kiosk.service", "sunroost.service", "sunroost-homeassistant.service"].indexOf(action.lookup("unit")) >= 0) {
    return polkit.Result.YES;
  }
});
RULES
cat > /etc/sudoers.d/sunroost <<'SUDO'
# Sunroost app: USB power cycling and its SSH access config file only.
Cmnd_Alias SOLAR_UNITS = /usr/bin/systemctl enable --now ssh, /usr/bin/systemctl disable --now ssh, \
  /usr/bin/systemctl enable --now bluetooth, /usr/bin/systemctl disable --now bluetooth, \
  /usr/bin/systemctl enable --now sunroost-kiosk, /usr/bin/systemctl disable --now sunroost-kiosk, \
  /usr/bin/systemctl reload ssh
sunroost ALL=(root) NOPASSWD: SOLAR_UNITS, /usr/sbin/uhubctl, /usr/bin/tee /etc/ssh/sshd_config.d/10-sunroost.conf, \
  /usr/sbin/iw reg set *, /usr/bin/raspi-config nonint do_wifi_country *, /usr/local/sbin/sunroost-ha-update *
SUDO
chmod 440 /etc/sudoers.d/sunroost
visudo -cf /etc/sudoers.d/sunroost

if [[ $MODE == image ]]; then
  systemctl enable sunroost
  # Reachable as http://sunroost.local on the LAN.
  echo sunroost > /etc/hostname
  sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tsunroost/' /etc/hosts
  grep -q '^127\.0\.1\.1' /etc/hosts || printf '127.0.1.1\tsunroost\n' >> /etc/hosts
  echo "Sunroost is installed in the image."
  exit 0
fi
systemctl daemon-reload
[[ $INSTALL_HA == 1 ]] && systemctl enable --now sunroost-homeassistant
systemctl enable --now sunroost
[[ $KIOSK == 1 ]] && systemctl enable sunroost-kiosk

echo "Sunroost is running: http://$(hostname -I | awk '{print $1}')/"
echo "Everything else is configured in the web UI (Configuration page)."
[[ $INSTALL_HA == 1 ]] && echo "Home Assistant is starting (the first start takes a few minutes); Sunroost sets it up and connects by itself."
true
