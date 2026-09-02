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

# Only seed the env file if it doesn't already exist, so re-running this
# script never clobbers a configured broker host/credentials.
if [ ! -f /etc/default/chrony-mqtt ]; then
  install -m 600 "$SCRIPT_DIR/.env.example" /etc/default/chrony-mqtt
  echo "Created /etc/default/chrony-mqtt -- edit it with your MQTT broker details before starting the service."
fi

systemctl daemon-reload
systemctl enable --now chrony-mqtt.service

echo "Installed. Service status:"
systemctl status chrony-mqtt.service --no-pager
