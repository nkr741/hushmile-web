// node --test web-viewer/test/
import assert from "node:assert/strict";
import test from "node:test";
import { batteryBand, cabLine, dayAndClock, helpLinks, isNightHour, nightQuiet, offRouteMinutes, roadLines, setLanguage, sosActive, sosBanner, viewState } from "../hushmile-viewer.js";
import { SAFETY } from "../safety-config.js";

const min = 60000;
const local = (h, m = 0, d = 23) => new Date(2026, 9, d, h, m).getTime();
const trip = { name: "Naveen", to: "Vijayawada", start: local(9), totalKm: 280, speedKmh: 60 };

test("config is the app's (config/safety.json)", () => {
  assert.equal(SAFETY.sos.holdMs, 3000);
  assert.deepEqual(SAFETY.countries.in.dial.map((n) => n.number), ["112", "108", "1033"]);
});

test("SOS banner: name, exact location with its age, call and map links, until I'm safe", () => {
  setLanguage("en");
  const now = local(11, 10);
  const spot = { km: 50, updatedAt: local(11, 9), fixAt: local(11, 8), checkin: "help", sosAt: local(11, 8), sos: true, lat: 17.1, lng: 79.2, place: "Suryapet", phone: "+91 90000 00000" };
  const b = sosBanner(spot, trip, now);
  assert.equal(b.title, "Naveen pressed SOS");
  assert.equal(b.body, "Last location Suryapet (17.10000° N, 79.20000° E), measured 2 min ago. Please call them now.");
  assert.equal(b.call.href, "tel:+919000000000");
  assert.equal(b.call.label, "Call Naveen");
  assert.ok(b.map.href.includes("17.100000,79.200000"));
  assert.equal(viewState({ trip, spot, now }).sos.title, "Naveen pressed SOS");
  assert.equal(sosBanner({ ...spot, checkin: "safe" }, trip, now), null);
  assert.equal(sosActive({ sos: true }), true);
  const noPhone = sosBanner({ ...spot, phone: undefined }, trip, now);
  assert.equal(noPhone.call, null);
  assert.match(noPhone.noPhone, /has not shared a number/);
});

test("off route for N minutes, calm; old phones keep the distance rule", () => {
  setLanguage("en");
  const spot = { km: 50, updatedAt: local(11, 6), offSince: local(11, 0), offKm: 3 };
  assert.equal(offRouteMinutes(spot), 6);
  assert.ok(roadLines(spot, trip, local(11, 7)).includes("Off the planned route for 6 min (may be a detour)"));
  assert.ok(!roadLines({ ...spot, offSince: 0 }, trip, local(11, 7)).some((l) => l.includes("route")));
  assert.ok(roadLines({ km: 50, updatedAt: local(11, 6), offKm: 3 }, trip, local(11, 7)).includes("Taking a different route than planned"));
});

test("battery bands and the quiet explanation at night", () => {
  setLanguage("en");
  assert.equal(batteryBand({ battery: 12 }), "low");
  assert.equal(batteryBand({ battery: 4 }), "critical");
  assert.equal(batteryBand({ battery: 4, charging: true }), null);
  assert.ok(roadLines({ km: 1, battery: 12, updatedAt: 1 }, trip, 2).includes("Phone battery low, updates may stop"));
  assert.equal(isNightHour(23), true);
  assert.equal(isNightHour(12), false);
  assert.equal(nightQuiet(20 * min, local(23)), 12 * min);
  assert.equal(nightQuiet(20 * min, local(12)), 20 * min);
  const at = local(23, 0);
  const state = viewState({ trip, spot: { km: 50, updatedAt: at, battery: 9, every: 120 }, now: at + 13 * min });
  assert.equal(state.title, "Signal gap");
  assert.match(state.sentence, /battery was 9%, so the phone may have switched off/);
  assert.doesNotMatch(state.sentence, /battery was low/, "the low battery is said once");
  assert.match(state.sentence, /At night Hushmile tells you sooner/);
});

test("help links: the country's numbers and map searches near the last place", () => {
  setLanguage("en");
  const h = helpLinks({ lat: 17.1, lng: 79.2 });
  assert.deepEqual(h.dial.map((d) => d.href), ["tel:112", "tel:108", "tel:1033"]);
  assert.equal(h.dial[2].label, "Highway help (NHAI) 1033");
  assert.equal(h.search.length, 2);
  assert.ok(h.search[0].href.includes("/maps/search/hospital/@17.10000,79.20000"));
  assert.equal(helpLinks({}).search.length, 0);
});

test("cab details line", () => {
  setLanguage("en");
  assert.equal(cabLine({ plate: "TS09AB1234", driver: "Ravi", operator: "Uber" }), "Uber · Vehicle TS09AB1234 · Driver Ravi");
  assert.equal(cabLine(null), null);
});

test("works-until day words from this browser's day", () => {
  setLanguage("en");
  assert.equal(dayAndClock(local(5, 11, 24), local(11, 11)), "tomorrow, 5:11 am");
  assert.equal(dayAndClock(local(20, 30), local(2, 30)), "today, 8:30 pm");
  assert.equal(dayAndClock(local(5, 11, 24), local(9, 0, 21)), "Sat 24 Oct, 5:11 am");
  setLanguage("hi");
  assert.equal(dayAndClock(local(5, 11, 24), local(11, 11)), "कल 5:11 am");
  setLanguage("en");
});
