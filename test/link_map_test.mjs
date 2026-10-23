// node --test test/  — journey format 3 (link key), its migration, and the map.
import assert from "node:assert/strict";
import test from "node:test";
import { KEY_API, landmarkLine, latest, linkKeyFromText, linkKeyId, linkKeyText, load, lookUpLinkKey, mapAgeLine, mapData, openFor, rainLine, readInput, sealFor, setLanguage, topicFor } from "../hushmile-viewer.js";

const CODE = "AB23-CD45";
const KEY = Uint8Array.from({ length: 16 }, (_, i) => i);

test("same keys and channels as the app (lib/seal.dart, vectors from Dart)", async () => {
  assert.equal(await topicFor(CODE, "spot", KEY), "h5325c6a6c7170d172ae36f4d69329f07");
  assert.equal(await topicFor(CODE, "spot"), "hcc0ec2c17c4997df3888b8da77ad6080");
  assert.equal(await linkKeyId(CODE), "8d3e396e17b14b2189c2af5f7f669794");
  assert.equal(linkKeyText(KEY), "AAECAwQFBgcICQoLDA0ODw");
  // A box sealed by the app (format 3) opens here with the key, never without.
  const box = "AxxZCIVZb44zVus06i7ZW45kLAQv9aU5eGS8b6AxyvfhTFi2-Q";
  assert.equal(await openFor(CODE, "spot", box, KEY), '{"km":7}');
  assert.equal(await openFor(CODE, "spot", box), null);
});

test("reading the link: old #CODE links and new #CODE.KEY links", () => {
  assert.deepEqual(readInput("AB23-CD45"), { code: CODE, key: null });
  assert.deepEqual(readInput("ab23cd45"), { code: CODE, key: null });
  const r = readInput("AB23-CD45.AAECAwQFBgcICQoLDA0ODw");
  assert.equal(r.code, CODE);
  assert.deepEqual([...r.key], [...KEY]);
  assert.deepEqual([...readInput("https://nkr741.github.io/hushmile-web/#AB23-CD45.AAECAwQFBgcICQoLDA0ODw").key], [...KEY]);
  assert.equal(readInput("AB23-CD45.short").key, null);
  assert.equal(linkKeyFromText("!!"), null);
});

function relayWith(messages) {
  // messages: {topic: [sealed, ...]}; the key server answers from `boxes`.
  return (boxes = {}) => {
    const asked = [];
    const fetcher = async (url) => {
      asked.push(url);
      const u = new URL(url);
      if (url.startsWith(KEY_API)) {
        const box = boxes[u.searchParams.get("id")];
        return box ? { ok: true, status: 200, json: async () => ({ box }) } : { ok: false, status: 404, json: async () => ({}) };
      }
      const topic = u.pathname.split("/")[1];
      const body = (messages[topic] || []).map((m, i) => JSON.stringify({ event: "message", time: 10 + i, message: m })).join("\n");
      return { ok: true, status: 200, text: async () => body };
    };
    return { fetcher, asked };
  };
}

const now = Date.UTC(2026, 9, 23, 9);
const tripBody = { name: "Naveen", to: "Vijayawada", poly: "_p~iF~ps|U_ulLnnqC", spd: 60, start: now - 3600000, stops: [["A", 0, 0, 0], ["Vijayawada", 1, 1, 120]] };
const spotBody = { km: 60, updatedAt: now - 60000, movedAt: now - 60000, lat: 17.2, lng: 79.4, trail: [[17.1, 79.3, 600], [17.15, 79.35, 300]] };

test("link path: a format 3 journey opens with the key from the link", async () => {
  const messages = {
    [await topicFor(CODE, "trip", KEY)]: [await sealFor(CODE, "trip", JSON.stringify(tripBody), KEY)],
    [await topicFor(CODE, "trip")]: [await sealFor(CODE, "trip", JSON.stringify(tripBody))],
    [await topicFor(CODE, "spot", KEY)]: [await sealFor(CODE, "spot", JSON.stringify(spotBody), KEY)],
  };
  const { fetcher, asked } = relayWith(messages)();
  const state = await load(CODE, fetcher, now, KEY);
  assert.equal(state.kmLeft, 60);
  assert.ok(!asked.some((u) => u.startsWith(KEY_API)), "a link with the key never asks the server");
  assert.equal(await latest(CODE, "spot", "3h", fetcher), null, "points are not on the old channel");
});

test("code path: a code-only link gets the key from the server (sealed with the code)", async () => {
  const messages = {
    [await topicFor(CODE, "trip", KEY)]: [await sealFor(CODE, "trip", JSON.stringify(tripBody), KEY)],
    [await topicFor(CODE, "spot", KEY)]: [await sealFor(CODE, "spot", JSON.stringify(spotBody), KEY)],
  };
  const boxes = { [await linkKeyId(CODE)]: await sealFor(CODE, "linkkey", linkKeyText(KEY)) };
  const { fetcher, asked } = relayWith(messages)(boxes);
  const state = await load(CODE, fetcher, now);
  assert.equal(state.kmLeft, 60);
  assert.equal(asked.filter((u) => u.startsWith(KEY_API)).length, 1);
  // Asked once per page.
  await load(CODE, fetcher, now);
  assert.equal(asked.filter((u) => u.startsWith(KEY_API)).length, 1);
});

test("old journeys (format 2) still open: no key on the server, or a key with nothing behind it", async () => {
  const OLD = "ZX23-CV45";
  const messages = {
    [await topicFor(OLD, "trip")]: [await sealFor(OLD, "trip", JSON.stringify(tripBody))],
    [await topicFor(OLD, "spot")]: [await sealFor(OLD, "spot", JSON.stringify(spotBody))],
  };
  const { fetcher } = relayWith(messages)();
  assert.equal(await lookUpLinkKey(OLD, fetcher), null);
  assert.equal((await load(OLD, fetcher, now)).kmLeft, 60);
  assert.equal((await load(OLD, fetcher, now, KEY)).kmLeft, 60, "falls back to format 2");
});

test("a busy key server is asked again later", async () => {
  const CODE2 = "QW23-ER45";
  let n = 0;
  const fetcher = async () => { n++; return { ok: false, status: 429, json: async () => ({}) }; };
  assert.equal(await lookUpLinkKey(CODE2, fetcher), null);
  assert.equal(await lookUpLinkKey(CODE2, fetcher), null);
  assert.equal(n, 2);
});

test("map data: planned route, trail with times, last place with its age", () => {
  const trip = { points: [[17, 79], [17.5, 79.5]] };
  const d = mapData(trip, spotBody);
  assert.equal(d.route.length, 2);
  assert.deepEqual(d.trail.map((p) => p[2]), [spotBody.updatedAt - 600000, spotBody.updatedAt - 300000]);
  assert.deepEqual(d.last, { lat: 17.2, lng: 79.4, at: spotBody.updatedAt });
  assert.equal(mapData(null, { km: 1, revoked: true, lat: 1, lng: 1 }), null, "an ended journey shows no live marker");
  assert.equal(mapData(null, { km: 1, lat: 200, lng: 1 }), null, "bad coordinates are dropped");
  setLanguage("en");
  assert.equal(mapAgeLine(now - 12 * 60000, now), "Last known place, 12 min ago");
});

test("landmark and rain lines, in each language", () => {
  setLanguage("en");
  assert.equal(landmarkLine({ lm: "Narkatpalli", lmKm: 8.2, lmRel: "past" }), "About 8.2 km past Narkatpalli");
  assert.equal(landmarkLine({ lm: "Narkatpalli", lmKm: 0.4, lmRel: "before" }), "About 1 km before Narkatpalli");
  assert.equal(landmarkLine({ lm: "Chityal", lmRel: "in" }), "In Chityal");
  assert.equal(landmarkLine({}), null);
  assert.match(rainLine({ rain: { at: now - 5 * 60000, mm: 6 } }, now), /checked 5 min ago/);
  assert.equal(rainLine({ rain: { at: now - 3 * 3600000 } }, now), null, "an old reading is not shown");
  for (const lang of ["te", "hi"]) {
    setLanguage(lang);
    assert.ok(!/About|past/.test(landmarkLine({ lm: "Narkatpalli", lmKm: 8, lmRel: "past" })), lang);
  }
  setLanguage("en");
});
