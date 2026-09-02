/**
 * chrony-status-card - Single consolidated card for a chrony-mqtt device.
 *
 * Uses loadCardHelpers to create native hui-gauge-card elements (needle/speedometer
 * style, same as HA's built-in gauge card) for the headline numeric metrics, plus a
 * compact stats row for everything else (offsets, frequency/skew, ref source, GPS state).
 *
 * Config:
 *   entity_prefix: string - sensor entity_id prefix, e.g. "chrony" for
 *     sensor.chrony_stratum (defaults to "chrony")
 *   ref_prefix: string - entity_id prefix used for the current/local reference
 *     sensors, which HA may have disambiguated with the device name baked in
 *     (e.g. "chrony_pihole_chrony"). Defaults to entity_prefix.
 *   title: string (optional, defaults to "Chrony NTP")
 *   icon: string (optional, defaults to "mdi:clock-check-outline")
 */
class ChronyStatusCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._helpers = null;
    this._cards = [];
    this._built = false;
    this._SUFFIXES = [
      "stratum", "leap_status", "reference_source", "number_of_sources",
      "last_offset", "rms_offset", "frequency", "skew",
      "root_delay", "root_dispersion",
    ];
  }

  static getStubConfig() {
    return { entity_prefix: "chrony", title: "Chrony NTP" };
  }

  setConfig(config) {
    this._config = config || {};
    this._refPfxCache = null;
    this._built = false;
    if (this._hass) this._render();
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!prev || !this._built || this._availabilityChanged(prev, hass)) {
      this._render();
    } else {
      for (const card of this._cards) card.hass = hass;
      this._updateFlippedGauges();
      this._renderStats();
      this._renderGpsInfo();
    }
  }

  // -- Entity helpers --------------------------------------------------------

  _pfx() {
    return this._config.entity_prefix || "chrony";
  }

  _refPfx() {
    if (this._config.ref_prefix) return this._config.ref_prefix;
    if (this._refPfxCache) return this._refPfxCache;
    // HA sometimes disambiguates these entity_ids by baking the device name
    // in (e.g. chrony_pihole_chrony_gps_reach) -- discover the real prefix
    // by finding any entity ending in a suffix we know should exist.
    const marker = "_local_reference_state";
    const match = this._hass && Object.keys(this._hass.states).find((id) => id.startsWith("sensor.") && id.endsWith(marker));
    this._refPfxCache = match ? match.slice("sensor.".length, -marker.length) : this._pfx();
    return this._refPfxCache;
  }

  _id(suffix) {
    return `sensor.${this._pfx()}_${suffix}`;
  }

  _refId(suffix) {
    return `sensor.${this._refPfx()}_${suffix}`;
  }

  _st(entityId) {
    const s = this._hass?.states[entityId];
    if (!s || s.state === "unavailable" || s.state === "unknown") return null;
    return s;
  }

  _num(entityId) {
    const s = this._st(entityId);
    if (!s) return null;
    const n = parseFloat(s.state);
    return isNaN(n) ? null : n;
  }

  _availabilityChanged(prev, curr) {
    const ids = [
      ...this._SUFFIXES.map((s) => this._id(s)),
      this._refId("gps_reach"),
      this._refId("gps_reach_human"),
      this._refId("current_reference_reach"),
      this._refId("gps_state"),
    ];
    return ids.some((id) => {
      const wasOk = prev.states[id] && prev.states[id].state !== "unavailable" && prev.states[id].state !== "unknown";
      const isOk = curr.states[id] && curr.states[id].state !== "unavailable" && curr.states[id].state !== "unknown";
      return wasOk !== isOk;
    });
  }

  _fmt(n, digits = 3) {
    return n === null ? "-" : n.toFixed(digits);
  }

  // -- Flipped gauge (low value = good = right/green side) --------------------
  // Native hui-gauge-card always maps min->left, max->right; there's no way to
  // reverse it. This clones HA's actual <ha-gauge> geometry/styling exactly
  // (same viewBox, radius, stroke-width, needle path, label/value styling) and
  // just mirrors the angle math so min lands on the right instead of the left.

  _polarToCartesian(r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    // mirrored version of ha-gauge's own `x = -r*cos, y = -r*sin`
    return { x: r * Math.cos(rad), y: -r * Math.sin(rad) };
  }

  // angle 0deg = right (min), angle 180deg = left (max) -- the flip
  _flippedAngle(value, min, max) {
    const frac = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return frac * 180;
  }

  _arcPath(r, angleStart, angleEnd) {
    const p1 = this._polarToCartesian(r, angleStart);
    const p2 = this._polarToCartesian(r, angleEnd);
    const largeArc = angleEnd - angleStart > 180 ? 1 : 0;
    return `M ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 0 ${p2.x} ${p2.y}`;
  }

  _flippedGaugeMarkup(entityId, name, min, max, severity) {
    // Exactly ha-gauge's own constants (viewBox "-50 -50 100 55", arcRadius 40,
    // stroke-width 12) so the arc renders at the same size/thickness as the
    // native Sources/GPS Reach gauges next to it.
    const r = 40;
    const bounds = [
      { from: min, to: severity.yellow, color: "var(--success-color)" },
      { from: severity.yellow, to: severity.red, color: "var(--warning-color)" },
      { from: severity.red, to: max, color: "var(--error-color)" },
    ];
    const bands = bounds
      .filter((b) => b.to > b.from)
      .map((b) => {
        const a1 = this._flippedAngle(b.from, min, max);
        const a2 = this._flippedAngle(b.to, min, max);
        return `<path d="${this._arcPath(r, a1, a2)}" fill="none" stroke="${b.color}" stroke-width="12" stroke-linecap="butt"/>`;
      })
      .join("");
    const slug = entityId.replace(/[^a-zA-Z0-9]/g, "_");
    // Needle path is ha-gauge's own paddle shape, mirrored in x (and sweep
    // flags flipped to match) since it sits at the right/min side at rest.
    const needlePath = "M 34,-3 L 40,-1 A 1,1,0,0,1,40,1 L 34,3 A 2,2,0,0,1,34,-3 Z";
    return `
      <div class="gauge-cell flipped-gauge" data-entity="${entityId}" data-min="${min}" data-max="${max}">
        <div class="fg-arc">
          <svg viewBox="-50 -50 100 55">
            ${bands}
            <path id="needle_${slug}" class="fg-needle" d="${needlePath}" style="transform: rotate(0deg)"/>
          </svg>
          <div class="fg-value" id="value_${slug}">-</div>
        </div>
        <p class="fg-name">${name}</p>
      </div>`;
  }

  _updateFlippedGauges() {
    for (const el of this.shadowRoot.querySelectorAll(".flipped-gauge")) {
      const entityId = el.dataset.entity;
      const min = parseFloat(el.dataset.min);
      const max = parseFloat(el.dataset.max);
      const value = this._num(entityId);
      const slug = entityId.replace(/[^a-zA-Z0-9]/g, "_");
      const needle = el.querySelector(`#needle_${slug}`);
      const valueEl = el.querySelector(`#value_${slug}`);
      if (valueEl) valueEl.textContent = value === null ? "-" : value;
      if (needle) {
        const angle = this._flippedAngle(value === null ? min : value, min, max);
        // mirrored shape needs the opposite (CCW) rotation direction to sweep the right way
        needle.style.transform = `rotate(${-angle}deg)`;
      }
    }
  }

  // -- Build ------------------------------------------------------------------

  async _render() {
    if (!this._helpers) {
      this._helpers = await window.loadCardHelpers();
    }
    this._built = true;
    this._build();
  }

  _gaugeCard(entityId, name, severity, max = 100, unit) {
    const card = this._helpers.createCardElement({
      type: "gauge",
      entity: entityId,
      name,
      needle: true,
      min: 0,
      max,
      severity,
      ...(unit ? { unit } : {}),
    });
    card.hass = this._hass;
    this._cards.push(card);
    return card;
  }

  _build() {
    this._cards = [];
    const { title = "Chrony NTP", icon = "mdi:clock-check-outline" } = this._config;

    const stratumId = this._id("stratum");
    const hasStratum = !!this._st(stratumId);

    const gaugeDefs = [
      { id: this._id("number_of_sources"), name: "Sources", severity: { red: 0, yellow: 2, green: 4 }, max: 8 },
    ].filter((d) => this._st(d.id));

    const gpsReachId = this._refId("gps_reach");
    const hasGps = !!(this._st(gpsReachId) || this._st(this._refId("gps_state")));

    const hasStats = this._st(this._id("leap_status")) || this._st(this._id("reference_source"));

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 12px 16px 14px; }
        .header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 4px;
          font-size: 1.05em;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .header ha-icon { --mdc-icon-size: 20px; color: var(--state-icon-color, #44739e); }
        .section-title {
          font-size: 0.78em;
          font-weight: 500;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.03em;
          margin: 2px 0 4px;
        }
        .gauge-row { display: flex; }
        .gauge-cell {
          flex: 1;
          min-width: 0;
          --ha-card-background: transparent;
          --ha-card-box-shadow: none;
          --ha-card-border-radius: 0;
          --ha-card-border-width: 0;
        }
        .flipped-gauge {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 12px;
          box-sizing: border-box;
        }
        .fg-arc { position: relative; width: 100%; max-width: 250px; }
        .fg-arc svg { display: block; width: 100%; overflow: visible; }
        .fg-needle {
          fill: var(--primary-text-color);
          stroke: var(--card-background-color);
          stroke-width: 1;
          stroke-linecap: round;
          transform-origin: 0 0;
        }
        .fg-value {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 10%;
          text-align: center;
          font-size: var(--ha-font-size-l, 1.5rem);
          color: var(--primary-text-color);
        }
        .fg-name {
          width: 100%;
          font-size: var(--ha-font-size-m, 1rem);
          margin: 4px 0 0;
          text-align: center;
          color: var(--primary-text-color);
        }
        .divider {
          border: none;
          border-top: 1px solid var(--divider-color, #e0e0e0);
          margin: 4px 0;
        }
        .gps-row { display: flex; align-items: center; gap: 8px; }
        .gps-gauge { flex: 0 0 40%; }
        .gps-info { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .gps-info-item { display: flex; justify-content: space-between; gap: 8px; font-size: 0.82em; }
        .gps-info-item .lbl { color: var(--secondary-text-color); }
        .gps-info-item .val { color: var(--primary-text-color); font-weight: 500; text-align: right; }
        .stats {
          display: flex;
          justify-content: space-around;
          flex-wrap: wrap;
          gap: 4px 12px;
          padding-top: 6px;
        }
        .stat {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 1px;
          min-width: 64px;
        }
        .stat ha-icon { --mdc-icon-size: 16px; color: var(--state-icon-color, #44739e); }
        .stat-lbl { font-size: 0.7em;  color: var(--secondary-text-color); }
        .stat-val { font-size: 0.88em; font-weight: 500; color: var(--primary-text-color); }
      </style>
      <ha-card>
        <div class="header">
          <ha-icon icon="${icon}"></ha-icon>
          <span>${title}</span>
        </div>
        <div class="gauge-row primary"></div>
        ${hasGps ? '<hr class="divider"><div class="section-title">GPS / Local Reference</div><div class="gps-row"><div class="gps-gauge"></div><div class="gps-info"></div></div>' : ""}
        ${hasStats ? '<hr class="divider"><div class="stats"></div>' : ""}
      </ha-card>`;

    const primaryRow = this.shadowRoot.querySelector(".gauge-row.primary");
    if (hasStratum) {
      primaryRow.insertAdjacentHTML("beforeend", this._flippedGaugeMarkup(stratumId, "Stratum", 1, 8, { yellow: 2, red: 4 }));
    }
    for (const def of gaugeDefs) {
      const cell = document.createElement("div");
      cell.className = "gauge-cell";
      cell.appendChild(this._gaugeCard(def.id, def.name, def.severity, def.max));
      primaryRow.appendChild(cell);
    }

    if (hasStratum) this._updateFlippedGauges();

    if (hasGps) {
      const gpsGaugeCell = this.shadowRoot.querySelector(".gps-gauge");
      if (this._st(gpsReachId)) {
        gpsGaugeCell.appendChild(this._gaugeCard(gpsReachId, "GPS Reach", { red: 0, yellow: 4, green: 6 }, 8));
      }
      this._renderGpsInfo();
    }

    if (hasStats) this._renderStats();
  }

  _renderGpsInfo() {
    const infoDiv = this.shadowRoot.querySelector(".gps-info");
    if (!infoDiv) return;

    const stateMap = { "*": "synced", "+": "acceptable", "-": "excluded", "?": "unreachable", "x": "falseticker", "~": "too variable" };
    const rawState = this._st(this._refId("gps_state"))?.state;
    const gpsState = rawState ? `${rawState} (${stateMap[rawState] || "unknown"})` : undefined;
    const gpsReach = this._st(this._refId("gps_reach_human"))?.state;
    const gpsOffset = this._num(this._refId("gps_offset"));
    const gpsMargin = this._num(this._refId("gps_margin"));

    const item = (label, value) =>
      value === null || value === undefined
        ? ""
        : `<div class="gps-info-item"><span class="lbl">${label}</span><span class="val">${value}</span></div>`;

    infoDiv.innerHTML = [
      item("State", gpsState),
      item("Reach", gpsReach),
      item("Offset", gpsOffset !== null ? `${this._fmt(gpsOffset, 6)} s` : null),
      item("Margin", gpsMargin !== null ? `${this._fmt(gpsMargin, 6)} s` : null),
    ].filter(Boolean).join("");
  }

  _renderStats() {
    const statsDiv = this.shadowRoot.querySelector(".stats");
    if (!statsDiv) return;

    const leap = this._st(this._id("leap_status"))?.state;
    const ref = this._st(this._id("reference_source"))?.state;
    const lastOffset = this._num(this._id("last_offset"));
    const rmsOffset = this._num(this._id("rms_offset"));
    const frequency = this._num(this._id("frequency"));
    const skew = this._num(this._id("skew"));
    const rootDelay = this._num(this._id("root_delay"));
    const rootDispersion = this._num(this._id("root_dispersion"));
    const refReach = this._st(this._refId("current_reference_reach"))?.state;

    const stat = (icon, label, value) =>
      value === null || value === undefined
        ? ""
        : `<div class="stat">
            <ha-icon icon="${icon}"></ha-icon>
            <div class="stat-lbl">${label}</div>
            <div class="stat-val">${value}</div>
          </div>`;

    statsDiv.innerHTML = [
      stat("mdi:clock-alert-outline", "Leap", leap),
      stat("mdi:server-network", "Ref Source", ref),
      stat("mdi:signal", "Ref Reach", refReach),
      stat("mdi:clock-fast", "Last Offset", lastOffset !== null ? `${this._fmt(lastOffset, 6)} s` : null),
      stat("mdi:sigma", "RMS Offset", rmsOffset !== null ? `${this._fmt(rmsOffset, 6)} s` : null),
      stat("mdi:sine-wave", "Frequency", frequency !== null ? `${this._fmt(frequency, 3)} ppm` : null),
      stat("mdi:pulse", "Skew", skew !== null ? `${this._fmt(skew, 3)} ppm` : null),
      stat("mdi:transit-connection-variant", "Root Delay", rootDelay !== null ? `${this._fmt(rootDelay, 6)} s` : null),
      stat("mdi:blur", "Root Disp.", rootDispersion !== null ? `${this._fmt(rootDispersion, 6)} s` : null),
    ].filter(Boolean).join("");
  }

  getCardSize() { return 3; }
}

customElements.define("chrony-status-card", ChronyStatusCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "chrony-status-card",
  name: "Chrony Status Card",
  description: "Consolidated stratum/sources/GPS gauges plus tracking stats for a chrony-mqtt device",
});
