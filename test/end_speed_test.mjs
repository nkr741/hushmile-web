// node --test test/
import assert from "node:assert/strict";
import test from "node:test";
import { endSentence, setLanguage, speedLine, viewState } from "../hushmile-viewer.js";

const points = [[17.41, 78.37], [17.415, 78.41]];
const trip = { name: "Naveen", from: "Lanco Hills Rd", to: "Lakshmi Nagar Colony", start: 0, totalKm: 10.5, speedKmh: 30, points };

test("an arrival far from the destination is shown as an end, with the distance", () => {
  setLanguage("en");
  const end = endSentence({ revoked: true, end: "ended", endSaid: "arrived", endAwayKm: 7.0, endAt: Date.UTC(2026, 9, 23, 6, 1) }, trip, "Naveen", trip.to);
  assert.equal(end.arrived, false);
  assert.match(end.sentence, /tapped I've arrived at .*, but the last location was 7\.0 km from Lakshmi Nagar Colony/);
  // A 1.3.5 phone sent only arrived:true; its last point was 7 km away.
  const legacy = endSentence({ revoked: true, arrived: true, lat: 17.412, lng: 78.345, at: 1 }, trip, "Naveen", trip.to);
  assert.equal(legacy.arrived, false);
  const there = endSentence({ revoked: true, arrived: true, lat: 17.4151, lng: 78.4099, at: 1 }, trip, "Naveen", trip.to);
  assert.equal(there.arrived, true);
});

test("ended elsewhere and expired read differently", () => {
  setLanguage("en");
  assert.match(endSentence({ end: "ended", endAt: 5, endPlace: "Shaikpet Flyover" }, trip, "Naveen", trip.to).sentence, /^Naveen ended the journey near Shaikpet Flyover at /);
  assert.match(endSentence({ end: "expired", endAt: 5 }, trip, "Naveen", trip.to).sentence, /expired/);
  const state = viewState({ trip, spot: { km: 3, revoked: true, end: "ended", endAt: 5, endPlace: "X", updatedAt: 5 }, now: 10 });
  assert.equal(state.title, "Tracking stopped");
  assert.equal(state.speed, null);
});

test("speed carries its age and the moving average; older phones show none", () => {
  setLanguage("en");
  const now = 1_000_000_000;
  assert.equal(speedLine({ kmh: 62, avgKmh: 48, kmhAt: now - 120000 }, now), "62 km/h, 2 min ago · Average 48 km/h while moving");
  assert.equal(speedLine({ kmh: 0, kmhAt: now - 5000 }, now), "Stopped, just now");
  assert.equal(speedLine({ km: 3 }, now), null);
  const state = viewState({ trip, spot: { km: 3, updatedAt: now - 60000, kmh: 40, kmhAt: now - 60000 }, now });
  assert.match(state.speed, /^40 km\/h, 1 min ago/);
  setLanguage("te");
  assert.match(speedLine({ kmh: 62, kmhAt: now - 120000 }, now), /వేగం/);
  setLanguage("en");
});
