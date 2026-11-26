// node --test web-viewer/test/
import assert from "node:assert/strict";
import test from "node:test";
import { catchUpLine, clock, sayableMinutes, sentArrival, staleLeftLine, deadAlertApplies, decodePoly, noUpdateAfter, load, openFor, readTrip, sealFor, shownCode, topicFor, viewState } from "../hushmile-viewer.js";

const CODE = "AB23-CD45";

test("same channel name as the app (lib/seal.dart)", async () => {
  assert.equal(await topicFor(CODE, "spot"), "hcc0ec2c17c4997df3888b8da77ad6080");
  assert.equal(await topicFor("ab23 cd45", "spot"), await topicFor(CODE, "spot"));
  assert.notEqual(await topicFor(CODE, "trip"), await topicFor(CODE, "spot"));
});

test("opens a point sealed by the app, and refuses wrong code or kind", async () => {
  const fromDart = "AoFRGX5fu6aWHxn0jRY0mqSqSa4klkedjAxe60ur4cJTiNqXY8-Hm2ipot0xTdt2d1psUJw";
  assert.equal(await openFor(CODE, "spot", fromDart), '{"km":7.5,"updatedAt":1}');
  assert.equal(await openFor("AB23-CD46", "spot", fromDart), null);
  assert.equal(await openFor(CODE, "trip", fromDart), null);
  const again = await sealFor(CODE, "spot", "x");
  assert.notEqual(again, await sealFor(CODE, "spot", "x"));
  assert.equal(await openFor(CODE, "spot", again), "x");
});

test("code from the fragment is normalised", () => {
  assert.equal(shownCode("ab23cd45"), CODE);
  assert.equal(shownCode(" AB23-cd45 "), CODE);
});

const now = Date.UTC(2026, 9, 22, 10, 0, 0);
const trip = { name: "Naveen", to: "Vijayawada", start: now - 60 * 60000, totalKm: 120, speedKmh: 60 };

test("waiting shows no fake progress", () => {
  const s = viewState({ trip, spot: null, now });
  assert.equal(s.title, "Waiting for a location");
  assert.equal(s.lastUpdate, null);
  // UX-03: grey and neutral, never "On time".
  assert.equal(s.tone, "quiet");
  assert.equal(s.waiting, true);
  assert.equal(s.sentence, "Waiting for the first update");
  assert.equal(s.body, "Usually within a minute after the journey starts.");
  assert.doesNotMatch(s.sentence, /On time/);
});

test("on track sentence and km left", () => {
  const s = viewState({ trip, spot: { km: 60, updatedAt: now - 60000, movedAt: now - 60000 }, now });
  assert.equal(s.title, "On track");
  assert.equal(s.kmLeft, 60);
  assert.match(s.sentence, /^On time\. About 1 h to go\.$/);
});

test("a longer traffic estimate at the start is not well behind", () => {
  const fresh = { name: "Raju", to: "Vijayawada", start: now - 2 * 60000, totalKm: 264, speedKmh: 60 };
  const s = viewState({ trip: fresh, spot: { km: 1, updatedAt: now, movedAt: now, roadMin: 310, place: "Nacharam" }, now });
  assert.equal(s.title, "On track");
  assert.match(s.sentence, /About 5 h 10 min to go/);
  assert.doesNotMatch(s.sentence, /well behind/);
});

test("delay gives one honest reason and never invents traffic", () => {
  const s = viewState({ trip, spot: { km: 30, updatedAt: now - 60000, movedAt: now - 60000, paceKmh: 35 }, now });
  assert.equal(s.title, "At risk");
  assert.match(s.sentence, /Moving slower than planned \(about 35 km\/h, planned 60\)\./);
  assert.doesNotMatch(s.sentence, /traffic/i);
  const told = viewState({ trip, spot: { km: 50, updatedAt: now - 60000, movedAt: now - 60000, checkin: "traffic" }, now });
  assert.match(told.sentence, /They said there is traffic\./);
});

test("gap, then dead-phone wording after 20 minutes", () => {
  const gap = viewState({ trip, spot: { km: 60, updatedAt: now - 9 * 60000, place: "Kodad" }, now });
  assert.equal(gap.title, "Signal gap");
  assert.match(gap.sentence, /^No new update\. Last update Kodad/);
  const dead = viewState({ trip, spot: { km: 60, updatedAt: now - 21 * 60000, place: "Kodad", battery: 6 }, now });
  assert.match(dead.sentence, /^No update since .*Last seen near Kodad, 60 km from the destination\. The battery was 6%, so the phone may have switched off\. 1 h to go as of .*\.$/, "app 1.1.1+128: how long was left, as of the last update");
});

test("slower announced rhythm is not a gap", () => {
  const s = viewState({ trip, spot: { km: 60, updatedAt: now - 10 * 60000, movedAt: now - 60000, every: 900 }, now });
  assert.notEqual(s.title, "Signal gap");
});

test("a stale dead-phone alert is ignored when a newer point exists", () => {
  const s = viewState({ trip, spot: { km: 60, updatedAt: now - 9 * 60000 }, dead: { lastAt: now - 30 * 60000 }, now });
  assert.match(s.sentence, /^No new update/);
  const t = viewState({ trip, spot: { km: 60, updatedAt: now - 9 * 60000 }, dead: { lastAt: now - 9 * 60000 }, now });
  assert.match(t.sentence, /^No update since/);
});

test("a dead-phone alert is judged by the newest point received, on the relay clock", () => {
  const S = 1_000_000_000_000;
  const quietMs = 20 * 60000;
  // Phone died right after S; the alert written 12 min earlier fires 33 min after it was written.
  const alert = { lastAt: S - 12 * 60000, fireAt: S + 21 * 60000, quietMs, every: 360, relayAt: S + 21 * 60000 + 5000 };
  assert.equal(deadAlertApplies(alert, { km: 1, updatedAt: S, relayAt: S + 1000 }), true, "newer points sent after it do not cancel it");
  assert.equal(deadAlertApplies(alert, { km: 1, updatedAt: S + 18 * 60000, relayAt: S + 18 * 60000 }), false, "a point received shortly before it fired does");
  assert.equal(deadAlertApplies({ ...alert, relayAt: undefined }, { km: 1, updatedAt: S }), true, "falls back to the driver's own clock");
  assert.equal(deadAlertApplies(alert, { km: 1, updatedAt: S, relayAt: S, paused: true }), false);
  assert.equal(deadAlertApplies(alert, { km: 1, updatedAt: S, relayAt: S, revoked: true }), false);
  assert.equal(noUpdateAfter(360), 20 * 60000);
  assert.equal(noUpdateAfter(900), 32 * 60000);
  const shown = viewState({ trip, spot: { km: 60, updatedAt: S, relayAt: S + 1000, place: "Kodad" }, dead: alert, now: S + 9 * 60000 });
  assert.match(shown.sentence, /^No update since/);
});

test("catch-up summary after a dead zone", () => {
  const line = catchUpLine({ from: now - 40 * 60000, km: 38.2, n: 90 }, now, "Suryapet");
  assert.equal(line, `Back online ${clock(now)}. Kept moving, 38 km covered while out of signal.`);
  const s = viewState({ trip, spot: { km: 98, updatedAt: now, movedAt: now, back: { from: now - 40 * 60000, km: 38, n: 90 } }, now });
  assert.ok(s.sentence.startsWith("Back online"));
});

test("help, paused, near, arrived and closed", () => {
  assert.equal(viewState({ trip, spot: { km: 60, updatedAt: now, checkin: "help" }, now }).tone, "help");
  assert.equal(viewState({ trip, spot: { km: 60, updatedAt: now - 30 * 60000, paused: true }, now }).title, "Sharing paused");
  assert.equal(viewState({ trip, spot: { km: 118, updatedAt: now, movedAt: now }, now }).title, "Near the destination");
  assert.equal(viewState({ trip, spot: { km: 120, updatedAt: now, revoked: true, interrupt: "closed", arrived: true }, now }).title, "Arrived safely");
  const closed = viewState({ trip, spot: { km: 60, updatedAt: now, revoked: true, interrupt: "closed", checkin: "help" }, now });
  assert.equal(closed.title, "Tracking stopped");
});

test("long stop asks for a check-in, using the driver's stop time", () => {
  const s = viewState({ trip, spot: { km: 60, updatedAt: now, movedAt: now - 31 * 60000, stopMin: 30, place: "Dhaba" }, now });
  assert.equal(s.title, "Check-in requested");
  const t = viewState({ trip, spot: { km: 60, updatedAt: now, movedAt: now - 20 * 60000, stopMin: 30 }, now });
  assert.notEqual(t.title, "Check-in requested");
});

test("route decodes and reads total from stops", () => {
  assert.deepEqual(decodePoly("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  const t = readTrip({ name: "A", to: "B", poly: "_p~iF~ps|U_ulLnnqC", spd: 50, veh: "bike", stops: [["A", 0, 0, 0], ["B", 1, 1, 250]] });
  assert.equal(t.totalKm, 250);
  assert.equal(t.speedKmh, 36);
  assert.equal(readTrip({ revoked: true }), null);
});

test("load() reads sealed messages from a relay", async () => {
  const sealed = {
    trip: await sealFor(CODE, "trip", JSON.stringify({ name: "Naveen", to: "Vijayawada", poly: "_p~iF~ps|U_ulLnnqC", spd: 60, start: now - 3600000, stops: [["A", 0, 0, 0], ["Vijayawada", 1, 1, 120]] })),
    spot: await sealFor(CODE, "spot", JSON.stringify({ km: 60, updatedAt: now - 60000, movedAt: now - 60000 })),
  };
  const topics = { [await topicFor(CODE, "trip")]: "trip", [await topicFor(CODE, "spot")]: "spot" };
  const fetcher = async (url) => {
    const topic = new URL(url).pathname.split("/")[1];
    const kind = topics[topic];
    const body = kind ? JSON.stringify({ event: "message", time: 1, message: sealed[kind] }) + "\n" : "";
    return { ok: true, text: async () => body };
  };
  const state = await load(CODE, fetcher, now);
  assert.equal(state.title, "On track");
  assert.equal(state.kmLeft, 60);
});

// ---- Languages, near-destination and battery (1.2.0) ----------------------
import { durationText, nearMinutes, pickLanguage, setLanguage } from "../hushmile-viewer.js";

test("UX-04: one duration rule, the same as the app", () => {
  setLanguage("en");
  assert.equal(durationText(45), "45 min");
  assert.equal(durationText(59), "59 min");
  assert.equal(durationText(60), "1 h");
  assert.equal(durationText(133), "2 h 13 min");
  assert.equal(durationText(245), "4 h 5 min");
  setLanguage("te");
  assert.equal(durationText(133), "2 గం. 13 నిమి.");
  setLanguage("hi");
  assert.equal(durationText(133), "2 घंटे 13 मिनट");
  setLanguage("en");
});
import { STRINGS } from "../i18n.js";

test("every web string exists in Telugu and Hindi, translated", () => {
  for (const key of Object.keys(STRINGS.en)) {
    for (const lang of ["te", "hi"]) {
      assert.equal(typeof STRINGS[lang][key], "function", `${lang} ${key}`);
      if (/[a-z]{3}/.test(STRINGS.en[key]({ n: 2, name: "R", place: "P", at: "1", to: "T" })) && !/^(webTitle)$/.test(key)) {
        assert.notEqual(STRINGS[lang][key]({ n: 2 }), STRINGS.en[key]({ n: 2 }), `${lang} ${key}`);
      }
    }
  }
});

test("language follows the browser unless one was chosen", () => {
  assert.equal(pickLanguage(null, ["te-IN", "en-US"]), "te");
  assert.equal(pickLanguage(null, ["hi"]), "hi");
  assert.equal(pickLanguage(null, ["fr-FR", "kn-IN"]), "kn", "Kannada is an app language since 1.7.1");
  assert.equal(pickLanguage(null, ["fr-FR", "ml-IN"]), "en");
  assert.equal(pickLanguage("hi", ["te-IN"]), "hi");
  assert.equal(pickLanguage("xx", ["en-GB"]), "en");
});

test("Telugu and Hindi sentences, with locale times", () => {
  try {
    setLanguage("te");
    const s = viewState({ trip, spot: { km: 60, updatedAt: now - 60000, movedAt: now - 60000 }, now });
    assert.match(s.sentence, /^సమయానికే వస్తున్నారు/);
    assert.match(clock(Date.UTC(2026, 9, 22, 10, 0)), /(AM|PM)$/);
    setLanguage("hi");
    const help = viewState({ trip, spot: { km: 60, updatedAt: now - 60000, checkin: "help", place: "Kodad" }, now });
    assert.equal(help.sentence, "Naveen ने Kodad पर मदद माँगी है। कृपया अभी फ़ोन करें।");
    assert.match(clock(Date.UTC(2026, 9, 22, 10, 0)), /(am|pm)$/);
  } finally {
    setLanguage("en");
  }
});

test("near uses the driver's geofence, says almost there and never arrived", () => {
  const near = viewState({ trip, spot: { km: 100, updatedAt: now - 60000, movedAt: now - 60000, near: true, nearM: 450, roadMin: 2 }, now });
  assert.equal(near.title, "Near the destination");
  assert.equal(near.sentence, "Almost there, arriving now.", "never about 1 or 2 min (app 1.1.1+128)");
  const nearer = viewState({ trip, spot: { km: 100, updatedAt: now - 60000, movedAt: now - 60000, near: true, nearM: 2500, roadMin: 6 }, now });
  assert.equal(nearer.sentence, "Almost there, about 6 min away.");
  const notYet = viewState({ trip, spot: { km: 118, updatedAt: now - 60000, movedAt: now - 60000, near: false }, now });
  assert.notEqual(notYet.title, "Near the destination", "an explicit false wins over the 3 km fallback");
  const legacy = viewState({ trip, spot: { km: 118, updatedAt: now - 60000, movedAt: now - 60000 }, now });
  assert.equal(legacy.title, "Near the destination");
  assert.equal(nearMinutes(2500), 6);
});

test("battery shows with charging, and under 10% the family is told updates may stop", () => {
  const charging = viewState({ trip, spot: { km: 60, updatedAt: now - 60000, movedAt: now - 60000, battery: 7, charging: true }, now });
  assert.equal(charging.battery, 7);
  assert.equal(charging.charging, true);
  assert.doesNotMatch(charging.sentence, /Updates may stop soon/);
  const low = viewState({ trip, spot: { km: 60, updatedAt: now - 60000, movedAt: now - 60000, battery: 7 }, now });
  assert.match(low.sentence, /Battery 7% and not charging, so updates may stop soon\.$/);
});

test("pickup line on a company trip: near with minutes, here, and only while fresh", async () => {
  const { pickupLines, roadLines, setLanguage: lang } = await import("../hushmile-viewer.js");
  lang("en");
  const now = 1_000_000_000;
  const near = { km: 1, updatedAt: now - 60000, pickup: { stage: "near", etaMin: 9 } };
  assert.deepEqual(pickupLines(near, now), ["The cab is about 9 min from the pickup.", "A rough guess from the distance and the average speed. It does not count traffic."]);
  assert.equal(roadLines(near, null, now)[0], "The cab is about 9 min from the pickup.");
  assert.deepEqual(pickupLines({ ...near, pickup: { stage: "here" } }, now), ["The cab has reached the pickup."]);
  assert.deepEqual(pickupLines({ ...near, updatedAt: now - 16 * 60000 }, now), []);
  assert.deepEqual(pickupLines({ ...near, pickup: { stage: "near" } }, now), []);
  assert.deepEqual(pickupLines({ km: 1, updatedAt: now }, now), []);
  assert.deepEqual(pickupLines({ ...near, pickup: { stage: "left" } }, now), []);
});

test("arrival state from the phone (app 1.1.1+128): arriving, at the destination, old updates, older phones", () => {
  const fresh = { updatedAt: now - 60000, movedAt: now - 60000 };
  // The state wins over the old near flag and the 3 km fallback.
  const onway = viewState({ trip, spot: { ...fresh, km: 118, arr: "onway" }, now });
  assert.notEqual(onway.title, "Near the destination");
  const arriving = viewState({ trip, spot: { ...fresh, km: 60, arr: "arriving", nearM: 900, roadMin: 4 }, now });
  assert.equal(arriving.title, "Near the destination");
  assert.equal(arriving.sentence, "Almost there, about 4 min away.");
  const soon = viewState({ trip, spot: { ...fresh, km: 119.5, arr: "arriving", nearM: 300, roadMin: 1 }, now });
  assert.equal(soon.sentence, "Almost there, arriving now.");
  const there = viewState({ trip, spot: { ...fresh, km: 120, arr: "atdest", near: true }, now });
  assert.equal(there.title, "At the destination");
  assert.match(there.sentence, /hasn't tapped I've arrived yet/);
  // On track never says about 1 or 2 min.
  const two = viewState({ trip: { ...trip, start: now - 60 * 60000 }, spot: { ...fresh, km: 100, roadMin: 2, arr: "onway" }, now });
  assert.doesNotMatch(two.sentence, /About [12] min/);
  // An old update: how long was left, as of its time.
  const old = now - 60 * 60000;
  const gap = viewState({ trip, spot: { km: 40, updatedAt: old, movedAt: old, roadMin: 25, arr: "onway" }, now });
  assert.equal(gap.title, "Signal gap");
  assert.ok(gap.sentence.endsWith(`25 min to go as of ${clock(old)}.`), gap.sentence);
  const gapThere = viewState({ trip, spot: { km: 120, updatedAt: old, movedAt: old, arr: "atdest" }, now });
  assert.ok(gapThere.sentence.endsWith(`Was at the destination as of ${clock(old)}.`), gapThere.sentence);
  // An older phone (no arr): the near flag as before; stale still says as of.
  const legacy = viewState({ trip, spot: { ...fresh, km: 100, near: true, nearM: 2500, roadMin: 6 }, now });
  assert.equal(legacy.title, "Near the destination");
  const legacyGap = viewState({ trip, spot: { km: 40, updatedAt: old, movedAt: old, roadMin: 25 }, now });
  assert.ok(legacyGap.sentence.endsWith(`25 min to go as of ${clock(old)}.`), legacyGap.sentence);
  assert.equal(sentArrival({ arr: "bogus" }), null);
  assert.equal(sayableMinutes(2.4), null);
  assert.equal(sayableMinutes(3), 3);
  assert.equal(staleLeftLine("arriving", 20, old), `Was arriving as of ${clock(old)}.`);
});
