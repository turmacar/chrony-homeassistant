#!/usr/bin/env bash
# Installs chrony-mqtt scripts and systemd units onto the local machine.
# Run as root, or with sudo, on the Pi that runs chronyd.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo $0)" >&2
  exit 1
fi

install -m 755 "$SCRIPT_DIR/chrony-mqtt.sh"      /usr/local/bin/chrony-mqtt.sh
install -m 755 "$SCRIPT_DIR/chronyc_tracking.sh" /usr/local/bin/chronyc_tracking.sh
install -m 755 "$SCRIPT_DIR/chronyc_sources.sh"  /usr/local/bin/chronyc_sources.sh

install -m 644 "$SCRIPT_DIR/chrony-mqtt.service" /etc/systemd/system/chrony-mqtt.service
install -m 644 "$SCRIPT_DIR/chrony-mqtt.timer"   /etc/systemd/system/chrony-mqtt.timer

systemctl daemon-reload
systemctl enable --now chrony-mqtt.timer

echo "Installed. Timer status:"
systemctl status chrony-mqtt.timer --no-pager
