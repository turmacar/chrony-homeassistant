#!/usr/bin/env bash
set -euo pipefail

# --- Config: edit these for your setup ---
MQTT_HOST="your-mqtt-broker"   # hostname or IP of your MQTT broker
MQTT_PORT="1883"
MQTT_USER="your-mqtt-username" # remove -u/-P from publish() below if no auth needed
MQTT_PASS="your-mqtt-password"
MQTT_BASE_TOPIC="chrony/$(hostname)"

publish() {
  mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" \
    -u "$MQTT_USER" -P "$MQTT_PASS" \
    -t "$1" -m "$2" -r
}

# Reach is an 8-bit octal bitmask; each bit is one of the last 8 polls
# (1 = got a valid reply, 0 = missed/failed). Convert to "successes/8".
reach_to_human() {
  local octal="$1"
  local dec=$((8#$octal))
  local count=0
  local i
  for i in 0 1 2 3 4 5 6 7; do
    (( (dec >> i) & 1 )) && count=$((count + 1))
  done
  echo "$count/8"
}

# --- Parse `chronyc -c tracking` (CSV output) ---
# Typical field order - run `chronyc -c tracking` once yourself and confirm
# these line up before trusting the values:
# 1 RefID, 2 RefIP, 3 Stratum, 4 RefTime, 5 SystemTime, 6 LastOffset,
# 7 RMSOffset, 8 Frequency, 9 ResidualFreq, 10 Skew, 11 RootDelay,
# 12 RootDispersion, 13 UpdateInterval, 14 LeapStatus
IFS=',' read -r ref_id ref_ip stratum ref_time sys_time last_offset \
  rms_offset frequency residual_freq skew root_delay root_dispersion \
  update_interval leap_status < <(chronyc -c tracking)

# --- Parse `chronyc -c sources`: build a JSON array of all sources, and
# find the currently selected (*) source for the summary fields below ---
ref_source="unknown"
num_sources=0
sources_json="["
first=true
while IFS=',' read -r mode state name src_stratum poll reach lastrx offset margin; do
  num_sources=$((num_sources + 1))
  if [ "$state" = "*" ]; then
    ref_source="$name"
  fi

  entry=$(cat <<EOF
{"mode":"$mode","state":"$state","name":"$name","stratum":$src_stratum,"poll":$poll,"reach":"$reach","reach_human":"$(reach_to_human "$reach")","last_rx":"$lastrx","offset":"$offset","margin":"$margin"}
EOF
)
  if $first; then
    sources_json="$sources_json$entry"
    first=false
  else
    sources_json="$sources_json,$entry"
  fi
done < <(chronyc -c sources)
sources_json="$sources_json]"

publish "$MQTT_BASE_TOPIC/sources" "$sources_json"

# --- Build and publish tracking summary JSON payload ---
payload=$(cat <<EOF
{
  "stratum": $stratum,
  "leap_status": "$leap_status",
  "last_offset": $last_offset,
  "rms_offset": $rms_offset,
  "frequency": $frequency,
  "skew": $skew,
  "root_delay": $root_delay,
  "root_dispersion": $root_dispersion,
  "ref_source": "$ref_source",
  "num_sources": $num_sources
}
EOF
)

publish "$MQTT_BASE_TOPIC/state" "$payload"
