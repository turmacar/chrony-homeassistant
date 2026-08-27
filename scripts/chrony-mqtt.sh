#!/usr/bin/env bash
set -euo pipefail

# --- Config: values come from the environment. Under systemd this is populated
# by EnvironmentFile=/etc/default/chrony-mqtt (see chrony-mqtt.service). For
# manual/interactive runs, a .env file next to this script is sourced instead.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.env"
  set +a
fi

MQTT_HOST="${MQTT_HOST:?Set MQTT_HOST in /etc/default/chrony-mqtt or scripts/.env}"
MQTT_PORT="${MQTT_PORT:-1883}"
MQTT_USER="${MQTT_USER:?Set MQTT_USER in /etc/default/chrony-mqtt or scripts/.env}" # remove -u/-P from publish() below if no auth needed
MQTT_PASS="${MQTT_PASS:?Set MQTT_PASS in /etc/default/chrony-mqtt or scripts/.env}"
MQTT_BASE_TOPIC="chrony/$(hostname)"
INTERVAL="${INTERVAL:-30}"  # seconds between polls

publish() {
  mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" \
    -u "$MQTT_USER" -P "$MQTT_PASS" \
    -t "$1" -m "$2" -r
}

reach_to_human() {
  local dec=$((8#$1)) count=0 i
  for i in 0 1 2 3 4 5 6 7; do (( (dec >> i) & 1 )) && count=$((count + 1)); done
  echo "$count/8"
}

reach_to_int() {
  local dec=$((8#$1)) count=0 i
  for i in 0 1 2 3 4 5 6 7; do (( (dec >> i) & 1 )) && count=$((count + 1)); done
  echo "$count"
}

# Cache IP -> hostname resolutions for the lifetime of the daemon
declare -A name_cache

resolve_name() {
  local addr="$1"
  # Only resolve bare IPv4 addresses; leave hostnames as-is
  if [[ "$addr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    if [[ -z "${name_cache[$addr]+x}" ]]; then
      name_cache[$addr]=$(getent hosts "$addr" 2>/dev/null | awk '{print $2; exit}' || echo "$addr")
      [ -z "${name_cache[$addr]}" ] && name_cache[$addr]="$addr"
    fi
    echo "${name_cache[$addr]}"
  else
    echo "$addr"
  fi
}

poll_and_publish() {
  # Fields: RefID RefIP Stratum RefTime SystemTime LastOffset RMSOffset
  #         Frequency ResidualFreq Skew RootDelay RootDispersion UpdateInterval LeapStatus
  IFS=',' read -r ref_id ref_ip stratum ref_time sys_time last_offset \
    rms_offset frequency residual_freq skew root_delay root_dispersion \
    update_interval leap_status < <(chronyc -c tracking)

  ref_source="unknown"
  num_sources=0
  gps_state="unknown"
  gps_reach_int=0
  gps_reach_human="0/8"
  current_ref_offset=0
  current_ref_margin=0
  current_ref_poll=0
  current_ref_reach=0
  local_ref_offset=0
  local_ref_margin=0
  local_ref_reach=0
  sources_json="["
  first=true

  # chronyc -c sources has 10 fields:
  # mode state name stratum poll reach lastrx last_offset offset_stdev margin
  while IFS=',' read -r mode state name src_stratum poll reach lastrx offset offset_stdev margin; do
    num_sources=$((num_sources + 1))
    local_name="$(resolve_name "$name")"
    [ "$state" = "*" ] && ref_source="$local_name"
      if [ "$state" = "*" ]; then
        current_ref_offset="$offset"
        current_ref_margin="$margin"
        current_ref_poll="$poll"
        current_ref_reach="$(reach_to_int "$reach")"
      fi
    # Capture GPS/local-reference clock fields for inclusion in the state payload
    if [ "$mode" = "#" ]; then
      gps_state="$state"
      gps_reach_human="$(reach_to_human "$reach")"
      gps_reach_int="$(reach_to_int "$reach")"
    fi
      if [ "$mode" = "#" ]; then
        local_ref_offset="$offset"
        local_ref_margin="$margin"
        local_ref_reach="$(reach_to_int "$reach")"
      fi
    rh="$(reach_to_human "$reach")"
    entry="{\"mode\":\"$mode\",\"state\":\"$state\",\"name\":\"$local_name\",\"stratum\":$src_stratum,\"poll\":$poll,\"reach\":\"$reach\",\"reach_human\":\"$rh\",\"last_rx\":\"$lastrx\",\"offset\":$offset,\"offset_stdev\":$offset_stdev,\"margin\":$margin}"
    if $first; then sources_json="$sources_json$entry"; first=false
    else sources_json="$sources_json,$entry"; fi
  done < <(chronyc -c sources)
  sources_json="$sources_json]"

  publish "$MQTT_BASE_TOPIC/sources" "$sources_json"

  publish "$MQTT_BASE_TOPIC/state" "{
    \"stratum\": $stratum,
    \"leap_status\": \"$leap_status\",
    \"system_time\": $sys_time,
    \"last_offset\": $last_offset,
    \"rms_offset\": $rms_offset,
    \"frequency\": $frequency,
    \"skew\": $skew,
    \"root_delay\": $root_delay,
    \"root_dispersion\": $root_dispersion,
    \"ref_source\": \"$ref_source\",
    \"num_sources\": $num_sources,
    \"gps_state\": \"$gps_state\",
    \"gps_reach\": $gps_reach_int,
    \"gps_reach_human\": \"$gps_reach_human\",
    \"current_ref_offset\": $current_ref_offset,
    \"current_ref_margin\": $current_ref_margin,
    \"current_ref_poll\": $current_ref_poll,
    \"current_ref_reach\": $current_ref_reach,
    \"local_ref_offset\": $local_ref_offset,
    \"local_ref_margin\": $local_ref_margin,
    \"local_ref_reach\": $local_ref_reach
  }"
}

while true; do
  poll_and_publish || true
  sleep "$INTERVAL"
done


publish() {
  mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" \
    -u "$MQTT_USER" -P "$MQTT_PASS" \
    -t "$1" -m "$2" -r
}

# Convert 8-bit octal reach mask to count of successful polls out of 8
reach_to_human() {
  local dec=$((8#$1)) count=0 i
  for i in 0 1 2 3 4 5 6 7; do (( (dec >> i) & 1 )) && count=$((count + 1)); done
  echo "$count/8"
}

# Convert 8-bit octal reach mask to plain integer (for Telegraf/InfluxDB)
reach_to_int() {
  local dec=$((8#$1)) count=0 i
  for i in 0 1 2 3 4 5 6 7; do (( (dec >> i) & 1 )) && count=$((count + 1)); done
  echo "$count"
}

poll_and_publish() {
  IFS=',' read -r ref_id ref_ip stratum ref_time sys_time last_offset \
    rms_offset frequency residual_freq skew root_delay root_dispersion \
    update_interval leap_status < <(chronyc -c tracking)

  ref_source="unknown"
  num_sources=0
  gps_state="unknown"
  gps_reach_int=0
  gps_reach_human="0/8"
  sources_json="["
  first=true

  while IFS=',' read -r mode state name src_stratum poll reach lastrx offset margin; do
    num_sources=$((num_sources + 1))
    [ "$state" = "*" ] && ref_source="$name"
    # Capture GPS/local-reference clock fields for inclusion in the state payload
    if [ "$mode" = "#" ]; then
      gps_state="$state"
      gps_reach_human="$(reach_to_human "$reach")"
      gps_reach_int="$(reach_to_int "$reach")"
    fi
    rh="$(reach_to_human "$reach")"
    entry="{\"mode\":\"$mode\",\"state\":\"$state\",\"name\":\"$name\",\"stratum\":$src_stratum,\"poll\":$poll,\"reach\":\"$reach\",\"reach_human\":\"$rh\",\"last_rx\":\"$lastrx\",\"offset\":\"$offset\",\"margin\":\"$margin\"}"
    if $first; then sources_json="$sources_json$entry"; first=false
    else sources_json="$sources_json,$entry"; fi
  done < <(chronyc -c sources)
  sources_json="$sources_json]"

  publish "$MQTT_BASE_TOPIC/sources" "$sources_json"

  publish "$MQTT_BASE_TOPIC/state" "{
    \"stratum\": $stratum,
    \"leap_status\": \"$leap_status\",
    \"last_offset\": $last_offset,
    \"rms_offset\": $rms_offset,
    \"frequency\": $frequency,
    \"skew\": $skew,
    \"root_delay\": $root_delay,
    \"root_dispersion\": $root_dispersion,
    \"ref_source\": \"$ref_source\",
    \"num_sources\": $num_sources,
    \"gps_state\": \"$gps_state\",
    \"gps_reach\": $gps_reach_int,
    \"gps_reach_human\": \"$gps_reach_human\"
  }"
}

while true; do
  poll_and_publish || true
  sleep "$INTERVAL"
done
