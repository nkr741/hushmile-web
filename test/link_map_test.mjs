// node --test test/  — journey format 3 (link key), its migration, and the map.
import assert from "node:assert/strict";
import test from "node:test";
import { ESCROW_N, KEY_API, KEY_LOOK_AGAIN_MS, escrowId, landmarkLine, latest, linkKeyFromText, linkKeyText, load, lookUpLinkKey, mapAgeLine, mapData, openFor, rainLine, readInput, scrypt, sealFor, setLanguage, topicFor, unwrapLinkKey, wrapLinkKey } from "../hushmile-viewer.js";

const CODE = "AB23-CD45";
const KEY = Uint8Array.from({ length: 16 }, (_, i) => i);

test("same keys and channels as the app (lib/seal.dart, vectors from Dart)", async () => {
  assert.equal(await topicFor(CODE, "spot", KEY), "h5325c6a6c7170d172ae36f4d69329f07");
  assert.equal(await topicFor(CODE, "spot"), "hcc0ec2c17c4997df3888b8da77ad6080");
  assert.equal(await escrowId(CODE), "9a0c894140099b46eff8b36a297b2442");
  // An escrow box made by the app (lib/linkkey.dart) opens here with the code only.
  const fromApp = { salt: "gU71JXWA-3nBx4j1_VpHtw", box: "-P-52BGqwTJOf27FD14FR8JKpUDwvorZOuYO4ACOtgt2DOf_CC0MZ7IVlgVxPpDtDz0" };
  assert.deepEqual([...(await unwrapLinkKey(CODE, fromApp))], [...KEY]);
  assert.equal(await unwrapLinkKey("ZZ99-ZZ99", fromApp), null);
  assert.equal(linkKeyText(KEY), "AAECAwQFBgcICQoLDA0ODw");
  // A box sealed by the app (format 3) opens here with the key, never without.
  const box = "AxxZCIVZb44zVus06i7ZW45kLAQv9aU5eGS8b6AxyvfhTFi2-Q";
  assert.equal(await openFor(CODE, "spot", box, KEY), '{"km":7}');
  assert.equal(await openFor(CODE, "spot", box), null);
});

test("scrypt matches RFC 7914 and the app's vectors", async () => {
  const h = (b) => Buffer.from(b).toString("hex");
  const te = new TextEncoder();
  assert.equal(h(await scrypt(new Uint8Array(), new Uint8Array(), 16, 1, 1, 64)), "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906");
  assert.equal(h(await scrypt(te.encode("AB23CD45"), Uint8Array.from({ length: 16 }, (_, i) => i), ESCROW_N)), "7e8e2dcf17bff610cd7e1953067a309983e11f2fc2f860765dfb8ea4e66d9b38");
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
    const posted = [];
    const fetcher = async (url, opts = {}) => {
      asked.push(url);
      const u = new URL(url);
      if (opts.method === "POST") {
        posted.push({ topic: u.pathname.split("/")[1], body: opts.body });
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.startsWith(KEY_API)) {
        const box = boxes[u.searchParams.get("id")];
        return box ? { ok: true, status: 200, json: async () => box } : { ok: false, status: 404, json: async () => ({}) };
      }
      const topic = u.pathname.split("/")[1];
      const body = (messages[topic] || []).map((m, i) => JSON.stringify({ event: "message", time: 10 + i, message: m })).join("\n");
      return { ok: true, status: 200, text: async () => body };
    };
    return { fetcher, asked, posted };
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
  assert.ok(!asked.some((u) => u.includes("firebase=no")), "a link with the key sends no 'seen' on the old channel");
  assert.equal(await latest(CODE, "spot", "3h", fetcher), null, "points are not on the old channel");
});

test("code path: a code-only page tells the phone, then gets the scrypt-wrapped key", async () => {
  const messages = {
    [await topicFor(CODE, "trip", KEY)]: [await sealFor(CODE, "trip", JSON.stringify(tripBody), KEY)],
    [await topicFor(CODE, "trip")]: [await sealFor(CODE, "trip", JSON.stringify(tripBody))],
    [await topicFor(CODE, "spot", KEY)]: [await sealFor(CODE, "spot", JSON.stringify(spotBody), KEY)],
  };
  const boxes = {};
  const { fetcher, asked, posted } = relayWith(messages)(boxes);
  // No box yet: the route shows (old channel), and the page says "seen" on the old channel.
  const first = await load(CODE, fetcher, now);
  assert.ok(first);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].topic, await topicFor(CODE, "seen"));
  assert.deepEqual(Object.keys(JSON.parse(await openFor(CODE, "seen", posted[0].body))).sort(), ["at", "seen"]);
  // The phone escrows; a minute later the page does not ask yet (rate limit)...
  boxes[await escrowId(CODE)] = await wrapLinkKey(CODE, KEY);
  await load(CODE, fetcher, now + 60000);
  assert.equal(asked.filter((u) => u.startsWith(KEY_API)).length, 1);
  // ...after KEY_LOOK_AGAIN_MS it does, and reads the format 3 points.
  const later = await load(CODE, fetcher, now + KEY_LOOK_AGAIN_MS + 1);
  assert.equal(later.kmLeft, 60);
  assert.equal(asked.filter((u) => u.startsWith(KEY_API)).length, 2);
  // Found keys are kept for the page.
  await load(CODE, fetcher, now + 3 * KEY_LOOK_AGAIN_MS);
  assert.equal(asked.filter((u) => u.startsWith(KEY_API)).length, 2);
});

test("format 3 only: a code-only page waits and tells the phone, then opens once the key is escrowed", async () => {
  const CODE3 = "PL23-MN45";
  const messages = {
    [await topicFor(CODE3, "trip", KEY)]: [await sealFor(CODE3, "trip", JSON.stringify(tripBody), KEY)],
    [await topicFor(CODE3, "spot", KEY)]: [await sealFor(CODE3, "spot", JSON.stringify(spotBody), KEY)],
  };
  const boxes = {};
  const { fetcher, asked, posted } = relayWith(messages)(boxes);
  setLanguage("en");
  // Nothing on the old channel, and no box yet: do not say the code is dead.
  const first = await load(CODE3, fetcher, now);
  assert.equal(first.waiting, true);
  assert.match(first.sentence, /Leave this page open/);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].topic, await topicFor(CODE3, "seen"));
  const seen = JSON.parse(await openFor(CODE3, "seen", posted[0].body));
  assert.equal(seen.seen, true);
  assert.equal(seen.v, undefined, "a code-only page must not send v:3, or the phone will not escrow");
  // Still no box a minute later: ask again. A 4 minute cache would leave the page blank.
  const mid = await load(CODE3, fetcher, now + 60000);
  assert.equal(mid.waiting, true);
  assert.equal(asked.filter((u) => u.startsWith(KEY_API)).length, 2);
  // The driver's phone escrows. The next refresh opens the format 3 journey.
  boxes[await escrowId(CODE3)] = await wrapLinkKey(CODE3, KEY);
  const later = await load(CODE3, fetcher, now + 120000);
  assert.equal(later.kmLeft, 60);
  assert.equal(later.waiting, undefined);
  assert.equal(asked.filter((u) => u.startsWith(KEY_API)).length, 3);
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
  for (const lang of ["te", "hi", "ta", "kn"]) {
    setLanguage(lang);
    assert.ok(!/About|past/.test(landmarkLine({ lm: "Narkatpalli", lmKm: 8, lmRel: "past" })), lang);
  }
  setLanguage("en");
});
