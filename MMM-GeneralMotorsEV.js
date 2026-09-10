Module.register("MMM-GeneralMotorsEV", {
  requiresVersion: "2.1.0",
  defaults: {
    username: null,
    password: null,
    totpSecret: null,
    onStarPin: null,
    deviceId: null,
    vin: null,
    displayName: null,
    demo: false,
    refreshInterval: 900,
    forceRefreshEV: false,
    forceRefreshEVInterval: null,
    asleepRefreshInterval: null,
    showApiDebug: false,
    timeFormat: 12,
    imperial: true,
    rangeDisplay: "%",
    hybridView: true,
    showMap: true,
    mapHeight: "220px",
    mapWidth: "100%",
    zoomLevel: 16,
    tileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    tileAttribution: "&copy; OpenStreetMap contributors",
    tileSubdomains: "abc",
    tileLabelUrl: null,
    mapStyle: "dark",
    mapTileFilter: "invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.9) saturate(0.35)",
    carImage: null,
    carImageOptions: {
      opacity: 0.9,
      scale: 1,
      verticalOffset: 0
    },
    sizeOptions: {
      width: 450,
      height: 175,
      batWidth: 250,
      batHeight: 45,
      topOffset: 0
    },
    displayOptions: {
      odometer: { visible: true },
      chargeTarget: { visible: true },
      battery12v: { visible: true },
      tpms: { visible: true },
      batteryBar: { visible: true },
      temperatures: { visible: true }
    },
    showTemps: "always",
    header: false,
    showHeader: true,
    metricOptions: {
      fontSize: "0.95rem",
      valueFontSize: null,
      lineHeight: "1.25rem",
      spacing: 0,
      valueSpacing: 12
    }
  },

  start() {
    this.vehicle = null;
    this.meta = {};
    this.errorMessage = null;
    this.map = null;
    this.marker = null;
    this._tileLayer = null;
    this._root = null;
    this._mapWrap = null;
    this._mapRefreshTimers = [];
    this._mapInitTimer = null;
    this._mapObserver = null;
    this._visObserver = null;
    if (this.config.showHeader === false && this.data) {
      this.data.header = undefined;
    }
    this.sendSocketNotification("GMV_CONFIG", this.getPayloadConfig());
  },

  notificationReceived(notification) {
    if (notification === "DOM_OBJECTS_CREATED") {
      this.sendSocketNotification("GMV_CONFIG", this.getPayloadConfig());
      this.watchModuleVisibility();
    } else if (notification === "SCENES_CHANGED") {
      // MMM-Scenes2 fires this between exit and enter; wait for the show animation.
      this.scheduleMapRefresh();
    }
  },

  suspend() {
    this.cancelMapRefresh();
  },

  resume() {
    if (this._mapWrap && !this.map) {
      this.initLeafletMap(this._mapWrap);
    }
    this.scheduleMapRefresh();
  },

  getPayloadConfig() {
    return {
      identifier: this.identifier,
      username: this.config.username,
      password: this.config.password,
      totpSecret: this.config.totpSecret || this.config.onStarTOTP,
      onStarPin: this.config.onStarPin,
      deviceId: this.config.deviceId,
      vin: this.config.vin,
      displayName: this.config.displayName,
      demo: this.config.demo,
      refreshInterval: this.config.refreshInterval,
      forceRefreshEV: this.config.forceRefreshEV,
      forceRefreshEVInterval: this.config.forceRefreshEVInterval,
      asleepRefreshInterval: this.config.asleepRefreshInterval,
      showApiDebug: this.config.showApiDebug,
      checkRequestStatus: this.config.checkRequestStatus,
      requestPollingIntervalSeconds: this.config.requestPollingIntervalSeconds,
      requestPollingTimeoutSeconds: this.config.requestPollingTimeoutSeconds
    };
  },

  getScripts() {
    return ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
  },

  getStyles() {
    return [
      "MMM-GeneralMotorsEV.css",
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
      "https://cdn.jsdelivr.net/npm/@mdi/font@7.4.47/css/materialdesignicons.min.css"
    ];
  },

  socketNotificationReceived(notification, payload) {
    if (!this.payloadIsForThis(payload)) {
      return;
    }
    if (notification === "GMV_VEHICLE") {
      this.vehicle = payload.vehicle;
      this.meta = payload.meta || {};
      this.errorMessage = null;
      this.updateDom(0);
    } else if (notification === "GMV_ERROR") {
      this.errorMessage = payload.message;
      this.meta = { ...(this.meta || {}), stale: true };
      if (payload.vehicle) {
        this.vehicle = payload.vehicle;
      }
      this.updateDom(0);
    }
  },

  getDom() {
    if (!this._root) {
      this._root = document.createElement("div");
      this._root.className = "gmv";
    }
    this.render(this._root);
    this.watchModuleVisibility();
    return this._root;
  },

  render(root) {
    const keptMap = this._mapWrap;
    if (keptMap && keptMap.parentNode) {
      keptMap.parentNode.removeChild(keptMap);
    }
    root.innerHTML = "";
    root.style.width = `${this.config.sizeOptions.width || 450}px`;

    if (!this.vehicle) {
      this.teardownMap();
      const loading = document.createElement("div");
      loading.className = "gmv-loading";
      loading.innerHTML = '<span class="mdi mdi-car-connected"></span> Connecting to OnStar…';
      if (this.errorMessage) {
        loading.textContent = this.errorMessage;
      }
      root.appendChild(loading);
      return;
    }

    root.appendChild(this.buildGraphic());
    if (this.config.hybridView) {
      root.appendChild(this.buildMetrics());
    }
    if (this.config.showMap) {
      root.appendChild(this.buildMap());
    } else {
      this.teardownMap();
    }
    if (this.errorMessage) {
      const err = document.createElement("div");
      err.className = "gmv-error";
      err.textContent = this.errorMessage;
      root.appendChild(err);
    }
  },

  buildGraphic() {
    const v = this.vehicle;
    const width = this.config.sizeOptions.width || 450;
    const carHeight = this.config.sizeOptions.height || 175;
    const wrap = document.createElement("div");
    wrap.className = "gmv-graphic";
    wrap.style.width = `${width}px`;
    wrap.style.marginTop = `${this.config.sizeOptions.topOffset || 0}px`;

    const hud = document.createElement("div");
    hud.className = "gmv-hud";

    const title = document.createElement("div");
    title.className = "gmv-title";
    title.textContent = v.displayName || [v.year, v.make, v.model].filter(Boolean).join(" ") || "GM Vehicle";
    if (this.shouldShowGraphicHeader()) {
      hud.appendChild(title);
    }

    const big = document.createElement("div");
    big.className = "gmv-soc";
    const useRange = this.wantsRangeDisplay();
    big.innerHTML = `<span class="gmv-soc-number">${this.escape(this.primaryNumber(v, useRange))}</span><span class="gmv-soc-unit">${this.escape(this.primaryUnit(v, useRange))}</span>`;

    const icons = document.createElement("div");
    icons.className = "gmv-status-icons";
    this.statusIcons(v).forEach((name) => {
      const i = document.createElement("span");
      i.className = `mdi ${name}`;
      icons.appendChild(i);
    });

    const socRow = document.createElement("div");
    socRow.className = "gmv-soc-row";
    socRow.appendChild(big);
    hud.appendChild(socRow);
    hud.appendChild(icons);

    const net = document.createElement("div");
    net.className = "gmv-network-icons";
    if (this.shouldShowTemps(v) && v.outsideTempC !== null && v.outsideTempC !== undefined) {
      const temps = document.createElement("div");
      temps.className = "gmv-temps";
      temps.innerHTML = `<span class="mdi mdi-thermometer"></span> ${this.escape(this.formatTemp(v.outsideTempC))}`;
      net.appendChild(temps);
    }
    const signal = document.createElement("span");
    signal.className = `mdi ${this.errorMessage ? "mdi-signal-off" : "mdi-signal"}`;
    net.appendChild(signal);
    hud.appendChild(net);
    wrap.appendChild(hud);

    const stage = document.createElement("div");
    stage.className = "gmv-car-stage";
    stage.style.maxHeight = `${carHeight}px`;
    const imgUrl = this.resolveCarImage();
    if (imgUrl) {
      const img = document.createElement("img");
      img.className = "gmv-car-image";
      img.src = imgUrl;
      img.alt = v.displayName || "GM vehicle";
      const scale = this.config.carImageOptions?.scale ?? 1;
      const offset = this.config.carImageOptions?.verticalOffset ?? 0;
      img.style.opacity = String(this.config.carImageOptions?.opacity ?? 0.85);
      if (scale !== 1) {
        img.style.transform = `scale(${scale})`;
        img.style.transformOrigin = "center center";
      }
      if (offset) {
        img.style.objectPosition = `center calc(50% + ${offset}px)`;
      }
      stage.appendChild(img);
    }
    wrap.appendChild(stage);

    const bottom = document.createElement("div");
    bottom.className = "gmv-graphic-bottom";
    if (this.config.displayOptions?.batteryBar?.visible !== false) {
      bottom.appendChild(this.buildBatteryBar(v));
    }
    wrap.appendChild(bottom);

    return wrap;
  },

  buildBatteryBar(v) {
    const raw = Number(v.batteryLevel);
    const valid = v.batteryLevel !== null && v.batteryLevel !== undefined && v.batteryLevel !== "" && Number.isFinite(raw) && raw >= 0 && raw <= 100;
    const level = valid ? raw : 0;
    const target = v.chargeTarget !== null && v.chargeTarget !== undefined ? Math.max(0, Math.min(100, Number(v.chargeTarget))) : null;
    const batWidth = this.config.sizeOptions?.batWidth || 250;
    const batHeight = this.config.sizeOptions?.batHeight || 45;

    const bar = document.createElement("div");
    bar.className = "gmv-battery-bar";
    if (v.charging) {
      bar.classList.add("is-charging");
    }

    const shell = document.createElement("div");
    shell.className = "gmv-battery-shell";
    shell.style.width = `${batWidth}px`;
    shell.style.height = `${batHeight}px`;

    const well = document.createElement("div");
    well.className = "gmv-battery-well";

    const fill = document.createElement("div");
    fill.className = "gmv-battery-fill";
    fill.style.width = `${level}%`;
    well.appendChild(fill);

    if (target !== null) {
      const tick = document.createElement("div");
      tick.className = "gmv-battery-target";
      tick.style.left = `${target}%`;
      tick.title = `Charge target ${target}%`;
      well.appendChild(tick);
    }

    const overlay = document.createElement("div");
    overlay.className = "gmv-battery-overlay";
    const socLine = document.createElement("div");
    socLine.className = "gmv-battery-soc";
    if (v.charging) {
      const bolt = document.createElement("span");
      bolt.className = "mdi mdi-lightning-bolt gmv-battery-bolt";
      socLine.appendChild(bolt);
    }
    const num = document.createElement("span");
    num.className = "gmv-battery-soc-number";
    num.textContent = valid ? String(Math.round(level)) : "--";
    const unit = document.createElement("span");
    unit.className = "gmv-battery-soc-unit";
    unit.textContent = "%";
    socLine.appendChild(num);
    socLine.appendChild(unit);
    overlay.appendChild(socLine);
    if (this.hasPlugVoltage(v)) {
      const volts = document.createElement("div");
      volts.className = "gmv-battery-voltage";
      volts.textContent = this.formatPlugVoltage(v);
      overlay.appendChild(volts);
    }
    well.appendChild(overlay);

    const nub = document.createElement("div");
    nub.className = "gmv-battery-nub";

    shell.appendChild(well);
    shell.appendChild(nub);
    bar.appendChild(shell);
    return bar;
  },

  buildMetrics() {
    const v = this.vehicle;
    const list = document.createElement("ul");
    list.className = "gmv-metrics";
    this.applyMetricStyles(list);

    if (v.charging && v.chargeEta) {
      this.addMetric(list, "mdi-clock-outline", "Time to target", this.formatEta(v.chargeEta));
    }

    if (this.config.displayOptions?.odometer?.visible !== false && v.odometerKm !== null) {
      this.addMetric(list, "mdi-counter", "Odometer", this.formatDistance(v.odometerKm));
    }

    if (this.config.displayOptions?.chargeTarget?.visible !== false && v.chargeTarget !== null && v.chargeTarget !== undefined) {
      this.addMetric(list, "mdi-battery-charging-80", "Charge target", `${Math.round(v.chargeTarget)}%`);
    }

    if (this.hasScheduledChargeStart(v)) {
      this.addMetric(list, "mdi-clock-start", "Scheduled charge", this.formatScheduledStart(v.scheduledChargeStart));
    }

    if (this.config.displayOptions?.battery12v?.visible !== false && v.battery12v !== null && v.battery12v !== undefined) {
      const unit = v.battery12vUnit || "V";
      this.addMetric(list, "mdi-car-battery", "12V battery", `${Number(v.battery12v).toFixed(1)} ${unit}`);
    }

    if (this.config.displayOptions?.tpms?.visible !== false && v.tires && v.tires.count) {
      const unit = this.tireUnitLabel(v.tires.unit);
      const parts = ["fl", "fr", "rl", "rr"]
        .filter((k) => v.tires[k] !== null && v.tires[k] !== undefined)
        .map((k) => this.formatTire(v.tires[k], v.tires.unit));
      this.addMetric(list, "mdi-car-tire-alert", "Tires", `${parts.join(" · ")} ${unit}`);
    }

    const updatedAt = v.lastAttemptAt || v.lastUpdated;
    if (updatedAt) {
      const when = new Date(updatedAt);
      if (!Number.isNaN(when.getTime())) {
        const failed = Boolean(v.stale || this.meta?.stale || v.fetchErrors?.evMetrics || v.fetchErrors?.diagnostics);
        const time = this.formatClock(when);
        let label = failed ? `Failed ${time}` : time;
        if (this.shouldShowNextRefresh(v)) {
          label += ` · next ${this.formatClock(new Date(v.nextRefreshAt))}`;
        }
        const title = failed
          ? `Refresh failed at ${time}. Showing last good data${v.lastUpdated ? ` from ${this.formatClock(new Date(v.lastUpdated))}` : ""}.${
              this.shouldShowNextRefresh(v) ? ` Next poll at ${this.formatClock(new Date(v.nextRefreshAt))}.` : ""
            }`
          : undefined;
        this.addMetric(list, "mdi-update", "Updated", label, { stale: failed, title });
      }
    }

    return list;
  },

  addMetric(list, icon, name, value, options) {
    const li = document.createElement("li");
    li.className = options?.stale ? "gmv-metric is-stale" : "gmv-metric";
    if (options?.title) {
      li.title = options.title;
    }
    li.innerHTML = `<span class="icon mdi ${icon}"></span><span class="name">${this.escape(name)}</span><span class="value">${this.escape(value)}</span>`;
    list.appendChild(li);
  },

  shouldShowNextRefresh(v) {
    if (!v || !v.rateLimited || !v.nextRefreshAt) {
      return false;
    }
    const when = new Date(v.nextRefreshAt);
    return !Number.isNaN(when.getTime()) && when.getTime() > Date.now() - 5000;
  },

  shouldShowGraphicHeader() {
    if (this.config.showHeader === false) {
      return false;
    }
    return !this.data?.header;
  },

  applyMetricStyles(list) {
    const opts = this.config.metricOptions || {};
    const fontSize = this.cssSize(opts.fontSize, "0.95rem");
    const valueSize = this.cssSize(opts.valueFontSize, fontSize);
    const lineHeight = this.cssSize(opts.lineHeight, "1.25rem");
    const rowGap = this.cssSize(opts.spacing, "0px");
    const valueGap = this.cssSize(opts.valueSpacing, "12px");
    list.style.setProperty("--gmv-metric-font-size", fontSize);
    list.style.setProperty("--gmv-metric-value-size", valueSize);
    list.style.setProperty("--gmv-metric-line-height", lineHeight);
    list.style.setProperty("--gmv-metric-row-gap", rowGap);
    list.style.setProperty("--gmv-metric-value-gap", valueGap);
  },

  cssSize(value, fallback) {
    if (value === null || value === undefined || value === "") {
      return fallback;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return `${value}px`;
    }
    return String(value);
  },

  buildMap() {
    const v = this.vehicle;
    const lat = Number(v.latitude);
    const lng = Number(v.longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    if (!hasCoords || typeof window.L === "undefined") {
      this.teardownMap();
      const wrap = document.createElement("div");
      wrap.className = "gmv-map-wrap gmv-map-empty";
      wrap.style.width = this.config.mapWidth || "100%";
      wrap.style.height = this.config.mapHeight || "220px";
      wrap.textContent = !hasCoords ? "Location unavailable" : "Loading map…";
      return wrap;
    }

    if (this._mapWrap && this._mapWrap.querySelector(".gmv-map")) {
      this.applyMapWrapSize(this._mapWrap);
      if (this.map) {
        this.syncMapPosition(lat, lng);
        if (this.hidden || !this.mapHasSize(this.map)) {
          this.scheduleMapRefresh();
        }
      } else {
        this.initLeafletMap(this._mapWrap);
      }
      return this._mapWrap;
    }

    const wrap = document.createElement("div");
    wrap.className = "gmv-map-wrap";
    this.applyMapWrapSize(wrap);
    const mapLook = this.resolveMapLook();
    if (mapLook.isLight) {
      wrap.classList.add("gmv-map-light-tiles");
    }
    const tileFilter = mapLook.mapTileFilter;
    if (tileFilter) {
      wrap.classList.add("gmv-map-dark-tiles");
      if (typeof tileFilter === "string") {
        wrap.style.setProperty("--gmv-map-tile-filter", tileFilter);
      }
    }

    const mapEl = document.createElement("div");
    mapEl.className = "gmv-map";
    wrap.appendChild(mapEl);
    this._mapWrap = wrap;
    this.initLeafletMap(wrap);
    return wrap;
  },

  initLeafletMap(wrap) {
    const mapEl = wrap && wrap.querySelector(".gmv-map");
    if (!mapEl || typeof window.L === "undefined") {
      return;
    }
    if (this.map) {
      this.scheduleMapRefresh();
      return;
    }
    if (this._mapInitTimer) {
      clearTimeout(this._mapInitTimer);
    }
    let attempts = 0;
    const start = () => {
      this._mapInitTimer = null;
      if (this.map) {
        this.scheduleMapRefresh();
        return;
      }
      if (!mapEl.isConnected) {
        attempts += 1;
        if (attempts > 40) {
          return;
        }
        this._mapInitTimer = setTimeout(start, 150);
        return;
      }
      const lat = Number(this.vehicle?.latitude);
      const lng = Number(this.vehicle?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }
      const mapLook = this.resolveMapLook();
      try {
        const map = window.L.map(mapEl, {
          zoomControl: false,
          attributionControl: true,
          dragging: false,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          boxZoom: false,
          keyboard: false
        }).setView([lat, lng], this.config.zoomLevel || 16);

        const tileOpts = {
          attribution: mapLook.tileAttribution,
          maxZoom: 19,
          subdomains: mapLook.tileSubdomains
        };
        const tileLayer = window.L.tileLayer(mapLook.tileUrl, tileOpts).addTo(map);
        if (mapLook.tileLabelUrl) {
          window.L.tileLayer(mapLook.tileLabelUrl, {
            maxZoom: 19,
            pane: "overlayPane"
          }).addTo(map);
        }

        const icon = window.L.divIcon({
          className: "gmv-marker",
          html: '<span class="mdi mdi-car"></span>',
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        });
        this.marker = window.L.marker([lat, lng], { icon }).addTo(map);
        this._tileLayer = tileLayer;
        this.map = map;
        this.observeMapContainer(wrap);
        this.scheduleMapRefresh();
      } catch (err) {
        this.scheduleMapRefresh();
      }
    };
    this._mapInitTimer = setTimeout(start, 50);
  },

  applyMapWrapSize(wrap) {
    wrap.style.width = this.config.mapWidth || "100%";
    wrap.style.height = this.config.mapHeight || "220px";
  },

  syncMapPosition(lat, lng) {
    const map = this.map;
    if (!map) {
      return;
    }
    try {
      map.setView([lat, lng], this.config.zoomLevel || 16, { animate: false });
      if (this.marker && typeof this.marker.setLatLng === "function") {
        this.marker.setLatLng([lat, lng]);
      }
    } catch (err) {
      // ignore
    }
  },

  teardownMap() {
    this.cancelMapRefresh();
    this.disconnectMapObserver();
    if (this._mapInitTimer) {
      clearTimeout(this._mapInitTimer);
      this._mapInitTimer = null;
    }
    if (this.map) {
      try {
        this.map.remove();
      } catch (err) {
        // ignore
      }
    }
    this.map = null;
    this.marker = null;
    this._tileLayer = null;
    this._mapWrap = null;
  },

  mapHasSize(map) {
    if (!map || typeof map.getSize !== "function") {
      return false;
    }
    const size = map.getSize();
    return Boolean(size && size.x > 0 && size.y > 0);
  },

  refreshMap() {
    const map = this.map;
    if (!map) {
      return;
    }
    try {
      if (!this.mapHasSize(map)) {
        return;
      }
      map.invalidateSize({ animate: false, pan: false });
      const lat = Number(this.vehicle?.latitude);
      const lng = Number(this.vehicle?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        this.syncMapPosition(lat, lng);
      }
      if (this._tileLayer && typeof this._tileLayer.redraw === "function") {
        this._tileLayer.redraw();
      }
    } catch (err) {
      // Leaflet throws if the container was detached mid-refresh.
    }
  },

  cancelMapRefresh() {
    for (const timer of this._mapRefreshTimers || []) {
      clearTimeout(timer);
    }
    this._mapRefreshTimers = [];
  },

  scheduleMapRefresh() {
    this.cancelMapRefresh();
    // MMM-Scenes2 default enter animation is 1000ms; MM hide uses display:none
    // so Leaflet caches a 0×0 size until the module is visible again.
    this._mapRefreshTimers = [0, 50, 250, 600, 1100, 1600].map((ms) =>
      setTimeout(() => this.refreshMap(), ms)
    );
  },

  disconnectMapObserver() {
    if (this._mapObserver) {
      this._mapObserver.disconnect();
      this._mapObserver = null;
    }
  },

  observeMapContainer(el) {
    this.disconnectMapObserver();
    if (!el || typeof ResizeObserver === "undefined") {
      return;
    }
    this._mapObserver = new ResizeObserver(() => {
      this.refreshMap();
    });
    this._mapObserver.observe(el);
  },

  watchModuleVisibility() {
    const node = this._root && this._root.closest ? this._root.closest(".module") : null;
    if (!node || typeof MutationObserver === "undefined") {
      return;
    }
    if (this._visObserver) {
      return;
    }
    this._visObserver = new MutationObserver(() => {
      if (!this.hidden) {
        this.scheduleMapRefresh();
      }
    });
    this._visObserver.observe(node, { attributes: true, attributeFilter: ["class", "style"] });
  },

  isLightMapStyle() {
    const style = String(this.config.mapStyle || "dark").toLowerCase().replace(/[\s_-]/g, "");
    return style === "light" || style === "teslamate" || style === "teslamatelocation";
  },

  resolveMapLook() {
    const isLight = this.isLightMapStyle();
    return {
      isLight,
      tileUrl: this.config.tileUrl || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      tileAttribution: this.config.tileAttribution || "&copy; OpenStreetMap contributors",
      tileSubdomains: this.config.tileSubdomains || "abc",
      tileLabelUrl: this.config.tileLabelUrl || null,
      mapTileFilter: isLight ? false : this.config.mapTileFilter
    };
  },

  resolveCarImage() {
    const configured = this.config.carImage;
    if (configured === false || configured === "none") {
      return null;
    }
    const aliases = {
      "sierra-ev": "images/cars/gmc-sierra-ev-denali-thunderstorm-gray.png",
      sierra: "images/cars/gmc-sierra-ev-denali-thunderstorm-gray.png",
      "gmc-sierra-ev-denali": "images/cars/gmc-sierra-ev-denali-thunderstorm-gray.png",
      bolt: "images/cars/chevrolet-bolt-2017-blue.png",
      "bolt-ev": "images/cars/chevrolet-bolt-2017-blue.png",
      "chevrolet-bolt": "images/cars/chevrolet-bolt-2017-blue.png"
    };
    if (typeof configured === "string" && aliases[configured]) {
      return this.file(aliases[configured]);
    }
    if (typeof configured === "string" && configured.length) {
      if (/^(https?:)?\/\//i.test(configured) || configured.startsWith("/")) {
        return configured;
      }
      return this.file(configured);
    }
    if (this.vehicle?.imageUrl) {
      return this.vehicle.imageUrl;
    }
    const blob = `${this.config.displayName || ""} ${this.vehicle?.make || ""} ${this.vehicle?.model || ""}`.toLowerCase();
    if (/bolt/.test(blob)) {
      return this.file(aliases.bolt);
    }
    if (/sierra/.test(blob)) {
      return this.file(aliases["sierra-ev"]);
    }
    return null;
  },

  statusIcons(v) {
    const icons = [];
    if (v.charging) {
      icons.push("mdi-lightning-bolt");
    } else if (v.pluggedIn) {
      icons.push("mdi-power-plug");
    }
    if (upper(v.ignition) === "ON") {
      icons.push("mdi-steering");
    }
    if (v.pluggedIn && !v.charging) {
      icons.push("mdi-ev-station");
    }
    return icons;
  },

  shouldShowTemps(v) {
    if (this.config.displayOptions?.temperatures?.visible === false) {
      return false;
    }
    if (this.config.showTemps === "never") {
      return false;
    }
    return v.outsideTempC !== null && v.outsideTempC !== undefined;
  },

  payloadIsForThis(payload) {
    if (!payload) {
      return false;
    }
    const myId = String(this.identifier || "");
    const theirId = String(payload.identifier || "");
    if (myId && theirId && myId !== theirId) {
      return false;
    }
    const myVin = String(this.config.vin || "").trim().toUpperCase();
    const theirVin = String(payload.vin || payload.vehicle?.vin || "").trim().toUpperCase();
    if (myVin && theirVin && myVin !== theirVin) {
      return false;
    }
    return Boolean((myId && theirId && myId === theirId) || (myVin && theirVin && myVin === theirVin));
  },

  wantsRangeDisplay() {
    const s = String(this.config.rangeDisplay ?? "").trim().toLowerCase();
    if (!s || s === "%" || s === "soc" || s === "percent" || s === "percentage" || s === "battery") {
      return false;
    }
    return s === "range" || s === "mi" || s === "km" || s === "miles" || s === "distance" || s.includes("range");
  },

  primaryNumber(v, useRange) {
    if (useRange) {
      if (v.rangeKm !== null && v.rangeKm !== undefined) {
        return this.config.imperial ? Math.round(v.rangeKm / 1.609344) : Math.round(v.rangeKm);
      }
      return "--";
    }
    const soc = Number(v.batteryLevel);
    if (v.batteryLevel !== null && v.batteryLevel !== undefined && v.batteryLevel !== "" && Number.isFinite(soc) && soc >= 0 && soc <= 100) {
      return Math.round(soc);
    }
    return "--";
  },

  primaryUnit(v, useRange) {
    if (useRange) {
      return this.config.imperial ? "mi" : "km";
    }
    return "%";
  },

  formatDistance(km) {
    if (km === null || km === undefined) {
      return "--";
    }
    if (this.config.imperial) {
      return `${Math.round(km / 1.609344).toLocaleString()} mi`;
    }
    return `${Math.round(km).toLocaleString()} km`;
  },

  formatTemp(c) {
    if (this.config.imperial) {
      return `${Math.round((c * 9) / 5 + 32)}°F`;
    }
    return `${Math.round(c)}°C`;
  },

  formatTire(value, unit) {
    if (value === null || value === undefined) {
      return "--";
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return "--";
    }
    const u = upper(unit);
    // GM often labels PSI readings as kPa. 57 kPa would be a flat tire; 57 PSI is normal.
    const looksKpa = n >= 140;
    const looksBar = n > 0 && n <= 12 && /BAR/.test(u) && !/KPA/.test(u);
    const kind = looksKpa ? "kpa" : looksBar ? "bar" : "psi";
    if (this.config.imperial) {
      if (kind === "kpa") {
        return (n / 6.89476).toFixed(0);
      }
      if (kind === "bar") {
        return (n * 14.5038).toFixed(0);
      }
      return n.toFixed(0);
    }
    if (kind === "psi") {
      return (n * 6.89476).toFixed(0);
    }
    if (kind === "bar") {
      return (n * 100).toFixed(0);
    }
    return n.toFixed(0);
  },

  tireUnitLabel(unit) {
    if (this.config.imperial) {
      return "psi";
    }
    if (/BAR/.test(upper(unit))) {
      return "bar";
    }
    return "kPa";
  },

  hasPlugVoltage(v) {
    const n = Number(v.plugVoltage);
    return Number.isFinite(n) && n > 0;
  },

  formatPlugVoltage(v) {
    const n = Number(v.plugVoltage);
    const unit = v.plugVoltageUnit && !/^N\/?A$/i.test(v.plugVoltageUnit) ? v.plugVoltageUnit : "V";
    const text = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
    return `${text} ${unit}`;
  },

  hasScheduledChargeStart(v) {
    const s = String(v.scheduledChargeStart || "").trim();
    if (!s) {
      return false;
    }
    return !/^(NA|N\/A|NONE|NULL|NOT.?SET|UNAVAILABLE|UNKNOWN|--)$/i.test(s);
  },

  formatClock(value) {
    const when = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(when.getTime())) {
      return "";
    }
    const twentyFour = this.config.timeFormat === 24 || this.config.timeFormat === "24";
    if (twentyFour) {
      return when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    return when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  },

  formatScheduledStart(value) {
    const s = String(value).trim();
    const isoish = new Date(s);
    if (!Number.isNaN(isoish.getTime()) && /\d{4}-\d{2}-\d{2}|T\d/.test(s)) {
      return this.formatClock(isoish);
    }
    const hm = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (hm) {
      const d = new Date();
      d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      return this.formatClock(d);
    }
    return s;
  },

  formatEta(iso) {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) {
      return String(iso);
    }
    const mins = Math.max(0, Math.round((when.getTime() - Date.now()) / 60000));
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hrs > 0) {
      return `${hrs}h ${rem}m`;
    }
    return `${rem} min`;
  },

  escape(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
});

function upper(value) {
  return String(value || "").toUpperCase();
}
