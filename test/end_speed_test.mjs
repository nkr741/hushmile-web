// node --test test/
import assert from "node:assert/strict";
import test from "node:test";
import { delayReason, endSentence, roadLines, setLanguage, speedLine, viewState } from "../hushmile-viewer.js";

const points = [[17.41, 78.37], [17.415, 78.41]];
const trip = { name: "Naveen", from: "Lanco Hills Rd", to: "Lakshmi Nagar Colony", start: 0, totalKm: 10.5, speedKmh: 30, points };

test("an arrival far from the destination is shown as an end, with the distance", () => {
  setLanguage("en");
  const end = endSentence({ revoked: true, end: "ended", endSaid: "arrived", endAwayKm: 7.0, endAt: Date.UTC(2026, 9, 23, 6, 1) }, trip, "Naveen", trip.to);
  assert.equal(end.arrived, false);
  assert.match(end.sentence, /tapped I've arrived at .*, about 7\.0 km from Lakshmi Nagar Colony/);
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

test("road facts and Google traffic as the late reason (app 1.4.0); older phones show none", () => {
  setLanguage("en");
  const now = Date.UTC(2026, 9, 23, 8, 0);
  const late = { ...trip, start: now - 4 * 3600000 };
  const spot = { km: 3, updatedAt: now - 60000, movedAt: now - 60000, road: "NH 65", toward: "Vijayawada", via: "NH 65", why: "traffic", whyPlace: "Suryapet", lateMin: 40 };
  const state = viewState({ trip: late, spot, now });
  assert.deepEqual(state.roads.slice(0, 2), ["On NH 65 towards Vijayawada", "Via NH 65"]);
  assert.match(state.sentence, /Heavy traffic near Suryapet/);
  assert.deepEqual(viewState({ trip, spot: { km: 3, updatedAt: now - 60000 }, now }).roads, []);
  const ride = viewState({ trip: late, spot: { km: 0, updatedAt: now - 60000, movedAt: now - 60000, board: "longwait", offKm: 3 }, now });
  assert.ok(ride.roads.includes("Taking a different route than planned"));
  assert.ok(ride.roads.some((l) => l.startsWith("Long wait at the boarding point (239 min)")));
});

test("a stay in the destination area without a tap is not 'Arrived'", () => {
  setLanguage("en");
  const end = endSentence({ revoked: true, end: "detected", endAt: 5 }, trip, "Naveen", trip.to);
  assert.equal(end.arrived, false);
  assert.match(end.sentence, /ended by itself/);
});

test("stop context lines; a toll plaza wait is not given as the delay", () => {
  setLanguage("en");
  assert.deepEqual(roadLines({ stopKind: "fuel", stopName: "HP" }), ["Stopped at a fuel station: HP"]);
  assert.equal(delayReason({ stillMin: 14, stopsMin: 0, paceKmh: null, plannedKmh: 60, stopKind: "toll" }), null);
  assert.match(delayReason({ stillMin: 14, stopsMin: 0, paceKmh: null, plannedKmh: 60, stopKind: "fuel" }), /^Stopped for 14/);
});

test("a check-in reply shows as a status with its age (app 1.4.1 quick replies)", async () => {
  const { repliedLine } = await import("../hushmile-viewer.js");
  setLanguage("en");
  const now = 1_700_000_000_000;
  assert.equal(repliedLine({ checkin: "break", repliedAt: now - 2 * 60000 }, now), "Taking a break, replied 2 min ago");
  assert.equal(repliedLine({ checkin: "traffic", repliedAt: now - 10000 }, now), "Stuck in traffic, replied just now");
  assert.equal(repliedLine({ checkin: "ok", repliedAt: now - 5 * 60000 }, now), "All fine, replied 5 min ago");
  assert.equal(repliedLine({ checkin: "help", repliedAt: now }, now), null);
  assert.equal(repliedLine({ checkin: "break" }, now), null);
  assert.deepEqual(roadLines({ checkin: "break", repliedAt: now - 60000 }, null, now), ["Taking a break, replied 1 min ago"]);
  setLanguage("hi");
  assert.equal(repliedLine({ checkin: "break", repliedAt: now - 3 * 60000 }, now), "थोड़ा ब्रेक ले रहे हैं, जवाब 3 मिनट पहले");
  setLanguage("en");
});
