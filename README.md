# chrony-homeassistant

NTP server monitoring stack. A Raspberry Pi running chrony (with a GPS input ) publishes its status to MQTT every 30 seconds, and Home Assistant consumes that data to expose it as a device with individual sensors.

## Architecture

```
+-------------------------------------+         +---------------------+
|  Pi running chronyd                 |         |  Home Assistant     |
|                                     |  MQTT   |                     |
|  chronyd  -->  chrony-mqtt.sh  ------+-------> |  mqtt_chrony.yaml   |
|  GPS HAT  --/  (systemd timer)      |         |  (sensors/device)   |
+-------------------------------------+         +---------------------+
```

## Pi-side setup

### Prerequisites

- `chrony` installed and running
- `mosquitto-clients` installed (`apt install mosquitto-clients`)
- MQTT broker reachable from the Pi

### Configuration

Credentials are read from environment variables, never hardcoded in the script:

- **systemd (production)**: `sudo scripts/install.sh` seeds `/etc/default/chrony-mqtt`
  from `scripts/.env.example` the first time it runs (it won't overwrite an
  existing file on re-install). Edit that file with your broker details.
- **manual/interactive runs**: copy `scripts/.env.example` to `scripts/.env`
  and fill it in; the script sources it automatically if present.

```bash
MQTT_HOST=your-mqtt-broker   # hostname or IP of your MQTT broker
MQTT_PORT=1883
MQTT_USER=your-mqtt-username
MQTT_PASS=your-mqtt-password
```

Neither `/etc/default/chrony-mqtt` nor `scripts/.env` are committed to git.

The topic base defaults to `chrony/<hostname>` using the Pi's hostname.

### Install

```bash
sudo scripts/install.sh
```

This copies the script and helper binaries to `/usr/local/bin/`, installs the systemd service to `/etc/systemd/system/`, and enables it immediately.

The service starts at boot, publishes every `INTERVAL` seconds (default 30, set in `/etc/default/chrony-mqtt`) via its own internal loop, and restarts automatically (`Restart=on-failure`) if it ever crashes.

### Watch helpers

```bash
chronyc_tracking.sh   # live view of `chronyc tracking`
chronyc_sources.sh    # live view of `chronyc sources -v`
```

## Home Assistant setup

1. Copy `homeassistant/mqtt_chrony.yaml` to your HA config directory.
2. Replace every occurrence of `YOUR_HOSTNAME` with the actual hostname of the Pi (must match what `hostname` returns on that machine).
3. Add to `configuration.yaml`:
   ```yaml
   mqtt: !include mqtt_chrony.yaml
   ```
4. Restart Home Assistant.

The integration creates a single device called "Chrony (YOUR_HOSTNAME)" containing sensors for stratum, offsets, frequency, skew, root delay/dispersion, source list, current reference, and local reference clock (GPS/PPS).

## GPS

Built using ATGM332D 5N31 GPS Beidou GLOSNASS receiving module

If you have a GPIO GPS HAT providing a local reference clock, it appears in chrony sources with mode `#`. The "Chrony Local Reference" sensors track its state and reach automatically. Without one, those sensors report "unknown", which is expected.

**gpsd must run persistently**, not just on-demand. Many distros only enable
`gpsd.socket` by default, which starts `gpsd` when a client connects and lets
it die when idle -- that stops it feeding the SHM/PPS data chrony's refclocks
read, even with a good satellite fix. Enable the service itself:

```bash
sudo systemctl enable --now gpsd.service
```

`gpsd`'s packaged unit also ships with no restart policy. Add one via a drop-in
instead of editing the packaged unit file:

```bash
sudo systemctl edit gpsd.service
```

```ini
[Service]
Restart=on-failure
RestartSec=5s
```

If GPS reach ever drops to 0 in `chronyc sources`, check
`systemctl is-active gpsd.service` before suspecting the antenna/hardware.

## MQTT topics

| Topic | Content |
|-------|---------|
| `chrony/<hostname>/state` | JSON tracking summary (stratum, offsets, frequency, etc.) |
| `chrony/<hostname>/sources` | JSON array of all chrony sources with reach decoded |

Messages are published retained, so HA sensors show a value immediately on
restart even before the next publish. Every sensor in `mqtt_chrony.yaml` sets
`expire_after: 90` (3x the default 30s interval) so entities go `unavailable`
if the publisher stops, instead of silently showing stale data forever.

## Lovelace Card: chrony-status-card

A custom card consolidating stratum/sources/GPS reach into gauges (same style
as HA's built-in gauge card) plus a compact stats row for offsets, frequency,
skew, and reference/GPS state -- one card instead of the multi-card dashboard
stacks in `homeassistant/lovelace_chrony_*.yaml`.

### Install

```bash
# Copy the card to HA's www directory (served at /local/)
scp lovelace-cards/chrony-status-card.js turmacar@homeassistant.lan:/home/turmacar/HomeAssistant/hass-config/www/

# Then in HA: Settings → Dashboards → ⋮ → Resources → Add resource
#   URL: /local/chrony-status-card.js   Type: JavaScript module
```

### Usage

```yaml
type: custom:chrony-status-card
entity_prefix: chrony
title: "Chrony (pihole)"
icon: mdi:clock-check-outline
```

The card auto-discovers the entity_id prefix used for the current/local
reference and GPS sensors (HA sometimes bakes the device name into them,
e.g. `chrony_pihole_chrony_gps_reach`) by searching for a `_local_reference_state`
suffix. Set `ref_prefix` explicitly only if that discovery picks the wrong thing.

Gauges only render for entities that exist, so this degrades gracefully if
you don't have a GPS refclock configured (no GPS Reach gauge, no GPS stat).
