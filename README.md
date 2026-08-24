# chrony-homeassistant

NTP server monitoring stack. A Raspberry Pi running chrony (optionally with a GPS HAT) publishes its status to MQTT every 30 seconds, and Home Assistant consumes that data to expose it as a device with individual sensors.

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

Edit `scripts/chrony-mqtt.sh` and set the four variables at the top:

```bash
MQTT_HOST="your-mqtt-broker"   # hostname or IP of your MQTT broker
MQTT_PORT="1883"
MQTT_USER="your-mqtt-username"
MQTT_PASS="your-mqtt-password"
```

The topic base defaults to `chrony/<hostname>` using the Pi's hostname.

### Install

```bash
sudo scripts/install.sh
```

This copies the script and helper binaries to `/usr/local/bin/`, installs the systemd service and timer to `/etc/systemd/system/`, and enables the timer immediately.

The timer fires 15 seconds after boot and then every 30 seconds.

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

## GPS HAT

If you have a GPIO GPS HAT providing a local reference clock, it appears in chrony sources with mode `#`. The "Chrony Local Reference" sensors track its state and reach automatically. Without one, those sensors report "unknown", which is expected.

## MQTT topics

| Topic | Content |
|-------|---------|
| `chrony/<hostname>/state` | JSON tracking summary (stratum, offsets, frequency, etc.) |
| `chrony/<hostname>/sources` | JSON array of all chrony sources with reach decoded |
