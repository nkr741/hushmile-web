// node --test web-viewer/test/
// The travel desk passenger's drop-off code on the watch page (app 1.1.1, API 1.5.17).
import assert from "node:assert/strict";
import test from "node:test";
import { DROP_API, dropCard, dropDone, readDrop, readInput, setLanguage } from "../hushmile-viewer.js";

const KEY = "0123456789abcdef0123456789abcdef";
const LINK_KEY = "AAECAwQFBgcICQoLDA0ODw";

test("a passenger link carries the drop-off key after the code; old links read as before", () => {
  assert.deepEqual(readInput(`https://watch.hushmile.com/#AB23-CD45.d${KEY}`), { code: "AB23-CD45", key: null, drop: KEY });
  const both = readInput(`#AB23-CD45.${LINK_KEY}.d${KEY}`);
  assert.equal(both.code, "AB23-CD45");
  assert.equal(both.drop, KEY);
  assert.equal(both.key.length, 16);
  assert.deepEqual(readInput("AB23-CD45"), { code: "AB23-CD45", key: null });
  // The passenger's own drop-off page from the drop_code WhatsApp message: no journey.
  assert.deepEqual(readInput(`https://watch.hushmile.com/#d${KEY}`), { code: "", key: null, drop: KEY });
  assert.deepEqual(readInput(`#d${KEY.toUpperCase()}`), { code: "", key: null, drop: KEY });
  assert.equal(readInput(`#d${KEY}.x`).drop, undefined, "only the bare page form");
  assert.equal(readInput("#d0123").drop, undefined);
  // Not 32 hex: not a drop-off key, and never taken for a link key.
  assert.deepEqual(readInput("#AB23-CD45.d0123"), { code: "AB23-CD45", key: null });
  // An older page took only what is before the first dot: the code still opens.
  assert.equal(`AB23-CD45.d${KEY}`.split(".")[0], "AB23-CD45");
});

test("the code is read with a POST body, never in the URL", async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ state: "open", code: "4821", vehicle: "TS09 AB 1234" }) };
  };
  assert.deepEqual(await readDrop(KEY, fake), { state: "open", code: "4821" });
  assert.equal(calls[0].url, DROP_API);
  assert.equal(calls[0].init.method, "POST");
  assert.ok(!calls[0].url.includes(KEY));
  assert.deepEqual(JSON.parse(calls[0].init.body), { key: KEY });
  // A bad key never reaches the network.
  assert.equal(await readDrop("nope", fake), null);
  assert.equal(calls.length, 1);
});

test("verified, closed, errors and odd answers", async () => {
  const answer = (status, body) => async () => ({ ok: status === 200, json: async () => body });
  assert.deepEqual(await readDrop(KEY, answer(200, { state: "verified", at: 1700000000000 })), { state: "verified", at: 1700000000000 });
  assert.deepEqual(await readDrop(KEY, answer(200, { state: "closed" })), { state: "closed" });
  assert.equal(await readDrop(KEY, answer(429, { error: "rate_limited" })), null);
  assert.equal(await readDrop(KEY, answer(200, { state: "open", code: "12a4" })), null);
  assert.equal(await readDrop(KEY, async () => { throw new Error("offline"); }), null);
});

test("the card: the code while open, then checked or ended, in each language", () => {
  setLanguage("en");
  const open = dropCard({ state: "open", code: "4821" });
  assert.equal(open.code, "4821");
  assert.equal(open.title, "Your drop-off code");
  assert.match(open.body, /your driver/);
  assert.match(dropCard({ state: "verified", at: Date.UTC(2026, 10, 27, 14, 5) }).body, /^Drop-off code checked at /);
  assert.match(dropCard({ state: "closed" }).body, /ended/);
  assert.equal(dropCard(null), null);
  for (const lang of ["te", "hi", "ta", "kn"]) {
    setLanguage(lang);
    const card = dropCard({ state: "open", code: "4821" });
    assert.ok(card.title.length > 0 && !/drop-off/i.test(card.title), lang);
  }
  setLanguage("en");
  assert.equal(dropDone({ state: "open", code: "1" }), false);
  assert.equal(dropDone({ state: "verified", at: 1 }), true);
  assert.equal(dropDone({ state: "closed" }), true);
});
