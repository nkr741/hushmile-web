// node --test test/  — what the web map draws (no browser needed).
import assert from "node:assert/strict";
import test from "node:test";
import { boundsOf, haloRadius, mapFeatures } from "../map-view.js";
import { mapConfig } from "../map-config.js";
import { mapData } from "../hushmile-viewer.js";

const data = { route: [[17.40, 78.55], [17.43, 78.56]], trail: [[17.41, 78.551, 1], [17.415, 78.552, 2]], last: { lat: 17.42, lng: 78.553, at: 3, hdg: 350, acc: 30 } };

test("planned route, road taken (trail up to the last place), dots and halo", () => {
  const f = mapFeatures(data);
  assert.deepEqual(f.route.features[0].geometry.coordinates, [[78.55, 17.40], [78.56, 17.43]]);
  assert.deepEqual(f.driven.features[0].geometry.coordinates, [[78.551, 17.41], [78.552, 17.415], [78.553, 17.42]]);
  assert.equal(f.dots.features.length, 2);
  assert.equal(f.dots.features[1].properties.age, 1);
  assert.equal(f.halo.features.length, 1);
  assert.equal(mapFeatures({ ...data, last: { ...data.last, acc: undefined } }).halo.features.length, 0);
  assert.equal(mapFeatures({ route: [[1, 2]], trail: [], last: null }).route.features.length, 0, "one point is no line");
});

test("the view fits every point; the halo grows with zoom", () => {
  assert.deepEqual(boundsOf(data), [[78.55, 17.40], [78.56, 17.43]]);
  assert.equal(boundsOf({ route: [], trail: [], last: null }), null);
  const r = haloRadius(30, 17.4);
  assert.equal(r[0], "interpolate");
  assert.ok(r[6] > 1000 && r[4] < 0.001);
});

test("heading and accuracy ride along when the phone sent them", () => {
  const trip = { points: [[17.4, 78.55], [17.43, 78.56]] };
  const d = mapData(trip, { lat: 17.42, lng: 78.553, updatedAt: 1000, hdg: 90, acc: 25 });
  assert.equal(d.last.hdg, 90);
  assert.equal(d.last.acc, 25);
  const old = mapData(trip, { lat: 17.42, lng: 78.553, updatedAt: 1000 });
  assert.deepEqual(old.last, { lat: 17.42, lng: 78.553, at: 1000 });
  assert.equal(mapData(trip, { lat: 17.42, lng: 78.553, updatedAt: 1000, acc: 99999 }).last.acc, undefined);
});

test("map settings: a free, keyless style; no Indic labels MapLibre would break", () => {
  assert.equal(mapConfig.engine, "maplibre");
  assert.match(mapConfig.styles.light, /^https:\/\/tiles\.openfreemap\.org\//);
  assert.ok(!JSON.stringify(mapConfig.labels).includes("nonlatin"));
});
