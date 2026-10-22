// node --test test/  (needs "type": "module"; see README)
import assert from "node:assert/strict";
import test from "node:test";
import { geohash, setLanguage, tilesAlong, viewState, weakCellsAlong, weakNear } from "../hushmile-viewer.js";

const points = [[17.385, 78.4867], [17.30, 79.0], [17.14, 79.62], [16.5062, 80.648]];
const trip = { name: "Ravi", from: "Hyderabad", to: "Vijayawada", start: 0, totalKm: 274, speedKmh: 60, points };

test("same cells and tiles as the app (lib/signal_map.dart)", () => {
  assert.equal(geohash(17.30, 79.0, 6), "tg04mt");
  assert.equal(geohash(57.64911, 10.40744, 11), "u4pruydqqvj");
  assert.deepEqual(tilesAlong(points), [...new Set(points.map(([a, b]) => geohash(a, b, 4)))]);
});

test("asks only for tiles and reads the published cells", async () => {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const tile = new URL(url).searchParams.get("tile");
    return { ok: true, json: async () => ({ tile, k: 5, cells: "tg04mt".startsWith(tile) ? [{ g: "tg04mt", n: 6, gap: 15 }] : [] }) };
  };
  assert.deepEqual(await weakCellsAlong(points, fetcher), { tg04mt: 15 });
  assert.ok(asked.every((u) => /^https:\/\/api\.hushmile\.com\/v1\/signal\?tile=[0-9b-z]{4}$/.test(u)));
  assert.deepEqual(await weakCellsAlong(points, async () => { throw new Error("offline"); }), {});
});

test("a gap in, or just before, a weak cell reads as expected, in each language", () => {
  const now = Date.UTC(2026, 9, 22, 9);
  const spot = { km: 60, updatedAt: now - 30 * 60000, every: 360, lat: 17.30, lng: 79.0 };
  const weak = { tg04mt: 15 };
  for (const lang of ["en", "te", "hi"]) {
    setLanguage(lang);
    const plain = viewState({ trip, spot, dead: null, now });
    const hinted = viewState({ trip, spot, dead: null, now, weak });
    assert.equal(hinted.title, "Signal gap");
    assert.ok(hinted.sentence.startsWith(plain.sentence) && hinted.sentence.length > plain.sentence.length, lang);
  }
  setLanguage("en");
  assert.match(viewState({ trip, spot, dead: null, now, weak }).sentence, /Signal is often weak here; gaps of about 15 minutes are usual/);
  // Heading into it from 5 km before.
  assert.equal(weakNear(weak, { lat: 17.33, lng: 78.95, points, km: 55 }), 15);
  // Not stale: no hint. Elsewhere: no hint.
  assert.doesNotMatch(viewState({ trip, spot: { ...spot, updatedAt: now - 60000 }, dead: null, now, weak }).sentence, /weak/);
  assert.equal(weakNear(weak, { lat: 17.14, lng: 79.62, points, km: 135 }), null);
});
