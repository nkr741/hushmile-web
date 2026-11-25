// node --test web-viewer/test/
import assert from "node:assert/strict";
import test from "node:test";
import { setLanguage } from "../hushmile-viewer.js";
import { errorWords, haltState, missingFirst, nudgeLink, parseTourHash, splitNames, tourPost, waDigits } from "../tour.js";

const A = "0123456789abcdef0123456789abcdef";
const B = "fedcba9876543210fedcba9876543210";

test("a tour link is two 32-hex parts after #", () => {
  assert.deepEqual(parseTourHash(`#${A}.${B}`), { tour: A, key: B });
  assert.deepEqual(parseTourHash(`#${A.toUpperCase()}.${B}`), { tour: A, key: B });
  assert.equal(parseTourHash(`#${A}`), null);
  assert.equal(parseTourHash(`#${A}.${B}.x`), null);
  assert.equal(parseTourHash("#AB23-CD45"), null);
  assert.equal(parseTourHash(""), null);
});

test("names box: one per line, optional phone after a comma, repeats dropped", () => {
  assert.deepEqual(splitNames("Lakshmi\n  Ravi Kumar , 98480 12345\n\nRavi Kumar, 9848012345\nSita, Ram\n" + "x".repeat(60)), [
    { name: "Lakshmi", phone: "" },
    { name: "Ravi Kumar", phone: "98480 12345" },
    { name: "Sita, Ram", phone: "" },
    { name: "x".repeat(40), phone: "" },
  ]);
  assert.deepEqual(splitNames(""), []);
});

test("halt countdown uses the given clock and says when it is late", () => {
  const view = { halt: { seq: 1, at: 0, leavesAt: 20 * 60000, place: "Srisailam" } };
  assert.deepEqual(haltState(view, 5 * 60000), { kind: "open", leavesAt: 20 * 60000, minLeft: 15, place: "Srisailam" });
  assert.equal(haltState(view, 19 * 60000 + 1).minLeft, 1);
  assert.equal(haltState(view, 20 * 60000 + 30000).lateMin, 1);
  assert.equal(haltState(view, 27 * 60000).kind, "late");
  assert.equal(haltState(view, 27 * 60000).lateMin, 7);
  assert.equal(haltState({ halt: { ...view.halt, endedAt: 1 } }, 0).kind, "ended");
  assert.equal(haltState({}, 0).kind, "none");
  assert.equal(haltState(null, 0).kind, "none");
});

test("guide sees who is missing first, in their own order", () => {
  const pax = [{ id: "a", back: true }, { id: "b", back: false }, { id: "c", back: true }, { id: "d", back: false }];
  assert.deepEqual(missingFirst(pax).map((p) => p.id), ["b", "d", "a", "c"]);
  assert.deepEqual(missingFirst(undefined), []);
});

test("WhatsApp reminder: India numbers get 91, the message has the name and time", () => {
  setLanguage("en");
  assert.equal(waDigits("98480 12345"), "919848012345");
  assert.equal(waDigits("+44 7700 900123"), "447700900123");
  assert.equal(waDigits("09848012345"), "919848012345");
  const leaves = new Date(2026, 10, 25, 15, 5).getTime();
  const url = nudgeLink({ name: "Ravi", phone: "9848012345" }, leaves);
  assert.ok(url.startsWith("https://wa.me/919848012345?text="));
  assert.equal(decodeURIComponent(url.split("text=")[1]), "Ravi, the bus leaves at 3:05 pm. Please come back to the bus.");
  assert.equal(nudgeLink({ name: "Ravi", phone: "" }, leaves), null);
  assert.equal(nudgeLink({ name: "Ravi", phone: "12345" }, leaves), null);
});

test("words in every language for the tour page", () => {
  for (const code of ["en", "te", "hi", "ta", "kn"]) {
    setLanguage(code);
    assert.ok(errorWords(401).length > 5, code);
    assert.ok(errorWords(429, "rate_limited").length > 5, code);
    assert.notEqual(errorWords(409, "bad_state"), errorWords(0), code);
  }
  setLanguage("en");
  assert.equal(errorWords(429, "tour_full"), "The list is full.");
});

test("posts the key in the body, never in the URL, and survives no connection", async () => {
  let seen = null;
  const ok = await tourPost("read", { tour: A, key: B }, async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ role: "board", pax: [] }) };
  });
  assert.equal(seen.url, "https://api.hushmile.com/v1/tour/read");
  assert.ok(!seen.url.includes(B));
  assert.equal(JSON.parse(seen.init.body).key, B);
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(ok, { ok: true, status: 200, body: { role: "board", pax: [] } });
  const down = await tourPost("read", {}, async () => { throw new TypeError("offline"); });
  assert.deepEqual(down, { ok: false, status: 0, body: null });
});
