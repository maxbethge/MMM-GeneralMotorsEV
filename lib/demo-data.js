"use strict";

const sierra = {
  vin: "DEMO-SIERRA-EV",
  displayName: "Sierra EV",
  make: "GMC",
  model: "Sierra EV Denali",
  year: "2025",
  batteryLevel: 72,
  chargeTarget: 80,
  rangeKm: 399,
  odometerKm: 7758,
  battery12v: 12.6,
  battery12vUnit: "V",
  tires: { fl: 42, fr: 42, rl: 40, rr: 40, unit: "psi", count: 4 },
  pluggedIn: true,
  charging: true,
  plugState: "plugged",
  chargeState: "CHARGING",
  chargeMode: "immediate",
  ignition: "off",
  latitude: 42.3314,
  longitude: -83.0458,
  heading: 88,
  outsideTempC: 21,
  chargeEta: new Date(Date.now() + 95 * 60 * 1000).toISOString(),
  plugVoltage: 240,
  plugVoltageUnit: "V",
  energyKwh: 143.2,
  lastUpdated: new Date().toISOString()
};

const bolt = {
  vin: "DEMO-BOLT-EV",
  displayName: "Bolt",
  make: "Chevrolet",
  model: "Bolt EV",
  year: "2017",
  batteryLevel: 55,
  chargeTarget: 90,
  rangeKm: 206,
  odometerKm: 100430,
  battery12v: 12.4,
  battery12vUnit: "V",
  tires: { fl: 38, fr: 38, rl: 36, rr: 36, unit: "psi", count: 4 },
  pluggedIn: false,
  charging: false,
  plugState: "unplugged",
  chargeState: "UNCONNECTED",
  chargeMode: "immediate",
  ignition: "off",
  latitude: 42.3601,
  longitude: -83.0677,
  heading: 12,
  outsideTempC: 18,
  scheduledChargeStart: "23:00",
  energyKwh: 60,
  advDiagnosticsStatus: "CHECK",
  advDiagnosticsStatusColor: "YELLOW",
  recommendedAction: "Inflate left front tire",
  lastUpdated: new Date().toISOString()
};

function demoForVin(vin, displayName) {
  const key = String(vin || displayName || "").toLowerCase();
  const now = new Date().toISOString();
  if (/bolt/.test(key)) {
    return { ...bolt, vin: vin || bolt.vin, displayName: displayName || bolt.displayName, lastUpdated: now };
  }
  return { ...sierra, vin: vin || sierra.vin, displayName: displayName || sierra.displayName, lastUpdated: now };
}

module.exports = { sierra, bolt, demoForVin };
