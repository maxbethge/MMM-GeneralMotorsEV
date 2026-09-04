"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const parser = require("./gm-parser");

const evSample = {
  status: "success",
  response: {
    data: {
      success: true,
      results: [
        {
          lat: 35.14096,
          lng: -89.90398,
          cplug: "unplugged",
          cstate: "UNCONNECTED",
          ign: "off",
          odo: 8783.15625,
          ravg: 317.98,
          soc: 70,
          kwh: 59.61,
          temp: 23,
          cmode: "immediate",
          tcl: 80,
          ceta: "2025-10-11T18:30:00.000-05:00"
        }
      ]
    }
  }
};

const diagnosticsSample = {
  response: {
    data: {
      name: "HEALTH_STATUS",
      diagnostics: [
        {
          name: "ODOMETER",
          diagnosticElements: [{ name: "ODOMETER", value: "4821", uom: "KM" }]
        },
        {
          name: "OIL LIFE",
          diagnosticElements: [{ name: "OIL LIFE", value: "88", uom: "%" }]
        },
        {
          name: "EV BATTERY LEVEL",
          diagnosticElements: [{ name: "EV BATTERY LEVEL", value: "72", uom: "%" }]
        },
        {
          name: "VEHICLE RANGE",
          diagnosticElements: [{ name: "EV RANGE", value: "399", uom: "KM" }]
        },
        {
          name: "INTERM VOLT BATT VOLT",
          diagnosticElements: [{ name: "INTERM VOLT BATT VOLT", value: "12.6", uom: "V" }]
        },
        {
          name: "EV PLUG VOLTAGE",
          diagnosticElements: [{ name: "EV PLUG VOLTAGE", value: "240", uom: "V" }]
        },
        {
          name: "EV SCHEDULED CHARGE START",
          diagnosticElements: [{ name: "EV SCHEDULED CHARGE START", value: "2026-09-01T04:00:00.000Z" }]
        },
        {
          name: "TIRE PRESSURE",
          diagnosticElements: [
            { name: "TIRE PRESSURE LF", value: "42", uom: "psi" },
            { name: "TIRE PRESSURE RF", value: "41", uom: "psi" },
            { name: "TIRE PRESSURE LR", value: "40", uom: "psi" },
            { name: "TIRE PRESSURE RR", value: "39", uom: "psi" }
          ]
        }
      ]
    }
  }
};

describe("gm-parser", () => {
  it("reads EV metrics including charge target and GPS", () => {
    const ev = parser.parseEvMetrics(evSample);
    assert.equal(ev.batteryLevel, 70);
    assert.equal(ev.chargeTarget, 80);
    assert.equal(ev.latitude, 35.14096);
    assert.equal(ev.longitude, -89.90398);
    assert.equal(ev.pluggedIn, false);
  });

  it("reads diagnostics and ignores oil life", () => {
    const diag = parser.parseDiagnostics(parser.unwrapResult(diagnosticsSample));
    assert.equal(diag.odometerKm, 4821);
    assert.equal(diag.battery12v, 12.6);
    assert.equal(diag.tires.count, 4);
    assert.equal(diag.tires.fl, 42);
    assert.equal(diag.tires.rr, 39);
    assert.equal(diag.plugVoltage, 240);
    assert.equal(diag.scheduledChargeStart, "2026-09-01T04:00:00.000Z");
    assert.equal(diag.oilLife, undefined);
  });

  it("maps LEFT FRONT style TPMS names", () => {
    const diag = parser.parseDiagnostics({
      diagnostics: [
        {
          name: "TIRE PRESSURE",
          diagnosticElements: [
            { name: "LEFT FRONT TIRE PRESSURE", value: "38", uom: "psi" },
            { name: "RIGHT FRONT TIRE PRESSURE", value: "37", uom: "psi" },
            { name: "LEFT REAR TIRE PRESSURE", value: "36", uom: "psi" },
            { name: "RIGHT REAR TIRE PRESSURE", value: "35", uom: "psi" }
          ]
        }
      ]
    });
    assert.equal(diag.tires.fl, 38);
    assert.equal(diag.tires.fr, 37);
    assert.equal(diag.tires.rl, 36);
    assert.equal(diag.tires.rr, 35);
  });

  it("ignores TPMS placeholders of 0", () => {
    const diag = parser.parseDiagnostics({
      diagnostics: [
        {
          name: "TIRE PRESSURE",
          diagnosticElements: [
            { name: "TIRE PRESSURE LF", value: "0", uom: "psi" },
            { name: "TIRE PRESSURE RF", value: "0", uom: "psi" },
            { name: "TIRE PRESSURE LR", value: "0", uom: "psi" },
            { name: "TIRE PRESSURE RR", value: "0", uom: "psi" }
          ]
        }
      ]
    });
    assert.equal(diag.tires.count, 0);
    assert.equal(diag.tires.fl, null);
  });

  it("does not treat four unnamed 0 placeholders as tire corners", () => {
    const diag = parser.parseDiagnostics({
      diagnostics: [
        {
          name: "TIRE PRESSURE",
          diagnosticElements: [
            { name: "TIRE PRESSURE", value: "0", uom: "psi" },
            { name: "TIRE PRESSURE", value: "0", uom: "psi" },
            { name: "TIRE PRESSURE", value: "0", uom: "psi" },
            { name: "TIRE PRESSURE", value: "0", uom: "psi" }
          ]
        }
      ]
    });
    assert.equal(diag.tires.count, 0);
  });

  it("omits unset plug voltage and scheduled charge start", () => {
    const diag = parser.parseDiagnostics({
      diagnostics: [
        {
          name: "EV PLUG VOLTAGE",
          diagnosticElements: [{ name: "EV PLUG VOLTAGE", value: "0", uom: "V" }]
        },
        {
          name: "EV SCHEDULED CHARGE START",
          diagnosticElements: [{ name: "EV SCHEDULED CHARGE START", value: "NA" }]
        }
      ]
    });
    assert.equal(diag.plugVoltage, undefined);
    assert.equal(diag.scheduledChargeStart, undefined);
  });

  it("lets EV charge target replace oil-life-style fields when merging", () => {
    const state = parser.parseAll({ diagnostics: diagnosticsSample, evMetrics: evSample });
    assert.equal(state.chargeTarget, 80);
    assert.equal(state.battery12v, 12.6);
    assert.equal(state.tires.count, 4);
    assert.equal(state.oilLife, undefined);
    assert.equal(state.latitude, 35.14096);
  });

  it("picks EV metrics for the requested VIN instead of results[0]", () => {
    const ev = parser.parseEvMetrics({
      response: {
        data: {
          results: [
            { vin: "VIN-SIERRA", soc: 72, ravg: 399, tcl: 80 },
            { vin: "VIN-BOLT", soc: 55, ravg: 206, tcl: 90 }
          ]
        }
      }
    }, "VIN-BOLT");
    assert.equal(ev.batteryLevel, 55);
    assert.equal(ev.rangeKm, 206);
    assert.equal(ev.chargeTarget, 90);
  });

  it("does not use another vehicle's EV metrics when VIN is present", () => {
    const ev = parser.parseEvMetrics({
      response: {
        data: {
          results: [{ vin: "VIN-SIERRA", soc: 72, ravg: 399 }]
        }
      }
    }, "VIN-BOLT");
    assert.equal(ev.batteryLevel, undefined);
    assert.equal(ev.rangeKm, undefined);
  });

  it("picks vehicle details for the requested VIN from a garage list", () => {
    const details = parser.parseVehicleDetails({
      vehicles: [
        { vin: "VIN-SIERRA", nickName: "Sierra EV" },
        { vin: "VIN-BOLT", nickName: "Bolt" }
      ]
    }, "VIN-BOLT");
    assert.equal(details.displayName, "Bolt");
    assert.equal(details.vin, "VIN-BOLT");
  });

  it("keeps previous SOC and range when a new poll has no EV metrics", () => {
    const previous = {
      batteryLevel: 70,
      rangeKm: 318,
      chargeTarget: 80,
      charging: true,
      plugState: "plugged",
      lastUpdated: "2026-01-01T00:00:00.000Z"
    };
    const next = parser.parseAll({ diagnostics: null, evMetrics: null });
    const kept = parser.keepPreviousValues(previous, next);
    assert.equal(next.batteryLevel, null);
    assert.equal(kept.batteryLevel, 70);
    assert.equal(kept.rangeKm, 318);
    assert.equal(kept.chargeTarget, 80);
    assert.equal(kept.charging, true);
  });

  it("keeps previous tire pressures when GM returns zeros", () => {
    const previous = {
      tires: { fl: 38, fr: 38, rl: 36, rr: 36, unit: "psi", count: 4 }
    };
    const next = parser.parseAll({
      diagnostics: {
        diagnostics: [
          {
            name: "TIRE PRESSURE",
            diagnosticElements: [
              { name: "TIRE PRESSURE LF", value: "0", uom: "psi" },
              { name: "TIRE PRESSURE RF", value: "0", uom: "psi" },
              { name: "TIRE PRESSURE LR", value: "0", uom: "psi" },
              { name: "TIRE PRESSURE RR", value: "0", uom: "psi" }
            ]
          }
        ]
      }
    });
    const kept = parser.keepPreviousValues(previous, next);
    assert.equal(next.tires.count, 0);
    assert.equal(kept.tires.fl, 38);
    assert.equal(kept.tires.rr, 36);
    assert.equal(kept.tires.count, 4);
  });
});
