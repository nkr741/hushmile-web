// node --test test/  — the marker glides, turns the short way, sits on the
// route within 60 m, and a push wakes the page (app 1.8.2).
import assert from "node:assert/strict";
import test from "node:test";
import { ease, GLIDE_MAX_M, lerpBearing, lerpPoint, markerLngLat, metresApart, shouldGlide } from "../map-view.js";
import { mapData, PRIMARY_RELAY, snapToRoute, SNAP_CORRIDOR_M, topicFor, WAKE_DELAY_MS, wakeTopics, wakeUrl } from "../hushmile-viewer.js";

test("the marker moves part of the way, eased, and ends exactly on the new place", () => {
  assert.deepEqual(lerpPoint([78, 17], [79, 18], 0.5), [78.5, 17.5]);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.5) > 0.5, "fast start, gentle stop");
  assert.equal(ease(2), 1);
});

test("the arrow turns the short way round", () => {
  assert.equal(lerpBearing(350, 10, 0.5), 0);
  assert.equal(lerpBearing(10, 350, 0.5), 0);
  assert.equal(lerpBearing(90, 180, 0.5), 135);
  assert.equal(lerpBearing(0, 0, 0.7), 0);
  assert.equal(lerpBearing(270, 90, 1), 90);
});

test("a long jump or reduce-motion does not glide", () => {
  const a = [78.5, 17.4];
  assert.equal(shouldGlide(a, [78.501, 17.4]), true);
  assert.equal(shouldGlide(a, [78.501, 17.4], true), false, "reduce motion");
  assert.equal(shouldGlide(a, a), false, "same place");
  assert.equal(shouldGlide(null, a), false, "first draw");
  assert.ok(metresApart(a, [78.6, 17.4]) > GLIDE_MAX_M);
  assert.equal(shouldGlide(a, [78.6, 17.4]), false, "signal gap jump");
});

test("near the route the marker sits on it; on a detour it stays at the real place", () => {
  const route = [[17.4, 78.5], [17.4, 78.6]];
  const near = snapToRoute(route, 17.4003, 78.55); // ~33 m off the line
  assert.ok(near);
  assert.ok(Math.abs(near[0] - 17.4) < 1e-9 && Math.abs(near[1] - 78.55) < 1e-9);
  assert.equal(snapToRoute(route, 17.401, 78.55), null, "~110 m away is a detour");
  assert.equal(snapToRoute([[17.4, 78.5]], 17.4, 78.5), null, "one point is no road");
  assert.equal(SNAP_CORRIDOR_M, 60);
  const d = mapData({ points: route }, { lat: 17.4003, lng: 78.55, updatedAt: 1 });
  assert.equal(d.last.lat, 17.4003, "the real place stays (halo, age)");
  assert.deepEqual(markerLngLat(d.last), [near[1], near[0]]);
  const off = mapData({ points: route }, { lat: 17.401, lng: 78.55, updatedAt: 1 });
  assert.equal(off.last.mark, undefined);
  assert.deepEqual(markerLngLat(off.last), [78.55, 17.401]);
  assert.equal(markerLngLat(null), null);
});

test("a push on the journey's channels wakes the page; polling stays the fallback", async () => {
  const code = "ABCD-EFGH";
  const key = new Uint8Array(32).fill(7);
  const both = await wakeTopics(code, key);
  assert.equal(both.length, 2);
  assert.equal(both[0], await topicFor(code, "spot", key));
  assert.equal(both[1], await topicFor(code, "spot", null));
  assert.deepEqual(await wakeTopics(code, null), [await topicFor(code, "spot", null)]);
  assert.equal(wakeUrl("habc"), `${PRIMARY_RELAY}/habc/sse`);
  assert.ok(WAKE_DELAY_MS > 0 && WAKE_DELAY_MS <= 3000);
});
