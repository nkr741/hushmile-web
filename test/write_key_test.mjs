// node --test test/  — the journey write key (app 1.6.9, docs/WRITE_KEY.md):
// a watch link can seal a message but not sign it, so a fake update is dropped.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { checkSigned, FALLBACK_RELAY, latest, linkKeyForPub, linkKeyText, notFromPhoneCount, PRIMARY_RELAY, pubMatchesLink, resetReads, resetTrust, sealFor, trustedPubFor, verifyEd25519 } from "../hushmile-viewer.js";

const CODE = "WK23-AB45";
const b64 = (b) => Buffer.from(b).toString("base64url");

// What only the traveller's phone can do (the app: lib/write_key.dart).
function writer(seed) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return {
    pub,
    sign(kind, obj) {
      const json = JSON.stringify(obj);
      const base = `${json.slice(0, -1)},"_pk":"${b64(pub)}","_sg":"${"A".repeat(86)}"}`;
      const sig = crypto.sign(null, Buffer.from(`hushmile-sig-v1\n${kind}\n${base}`), key);
      return `${base.slice(0, -88)}${b64(sig)}"}`;
    },
  };
}

test("same signature and link key as the app and the server (vectors)", async () => {
  const signed = '{"km":44,"at":1,"_pk":"A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg","_sg":"SP6Wk7HpS6k8os7BFin4SwYu0mHKte8YBOi-PgUo47ch70xhX0bUOOZZY0WYBusb8hE-6oJsuL8rAI_a9Hw-Bw"}';
  const check = await checkSigned("spot", signed);
  assert.equal(check.state, "valid");
  assert.deepEqual(check.clean, { km: 44, at: 1 });
  assert.equal((await checkSigned("trip", signed)).state, "broken", "a point cannot pass as a route");
  assert.equal((await checkSigned("spot", signed.replace('"km":44', '"km":45'))).state, "broken");
  assert.equal((await checkSigned("spot", '{"km":44}')).state, "unsigned");
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
  const w = writer(seed);
  assert.equal(b64(w.pub), "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg");
  assert.equal(w.sign("spot", { km: 44, at: 1 }), signed, "Node signs like Dart");
  assert.equal(linkKeyText(await linkKeyForPub(w.pub)), "ZbQWS1I5dVXsHY98GwxRaw");
});

test("the bundled TweetNaCl agrees with WebCrypto (browsers without Ed25519)", async () => {
  const require = createRequire(import.meta.url);
  const nacl = require("../vendor/nacl.min.js");
  const w = writer(Uint8Array.from({ length: 32 }, (_, i) => 31 - i));
  const signed = w.sign("dead", { at: 5 });
  const sig = Buffer.from(signed.slice(-88, -2), "base64url");
  const base = Buffer.from(`hushmile-sig-v1\ndead\n${signed.slice(0, -88)}${"A".repeat(86)}"}`);
  assert.equal(nacl.sign.detached.verify(base, sig, w.pub), true);
  assert.equal(nacl.sign.detached.verify(Buffer.concat([base, Buffer.from("x")]), sig, w.pub), false);
  assert.equal(await verifyEd25519(w.pub, sig, base), true);
});

function relays() {
  const state = { msgs: { [PRIMARY_RELAY]: [], [FALLBACK_RELAY]: [] }, n: 0 };
  state.add = async (relay, plain, link) => {
    state.n++;
    state.msgs[relay].push({ id: `m${state.n}`, event: "message", time: 100 + state.n, message: await sealFor(CODE, "spot", plain, link) });
  };
  state.fetcher = async (url) => {
    const u = new URL(url);
    const all = state.msgs[`${u.protocol}//${u.host}`];
    const since = u.searchParams.get("since");
    const at = all.findIndex((m) => m.id === since);
    const out = at >= 0 ? all.slice(at + 1) : all;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => out.map((m) => JSON.stringify(m)).join("\n") };
  };
  return state;
}

test("a watch-code holder cannot post an accepted update", async () => {
  resetReads();
  resetTrust();
  const traveller = writer(crypto.randomBytes(32));
  const link = await linkKeyForPub(traveller.pub);
  const r = relays();
  await r.add(PRIMARY_RELAY, traveller.sign("spot", { km: 12, place: "Suryapet" }), link);
  // Whoever holds the link seals fake points on ntfy.sh: unsigned, and signed by their own key.
  await r.add(FALLBACK_RELAY, JSON.stringify({ km: 99, place: "FAKE", sos: true }), link);
  await r.add(FALLBACK_RELAY, writer(crypto.randomBytes(32)).sign("spot", { km: 98, place: "FAKE2" }), link);
  const got = await latest(CODE, "spot", "3h", r.fetcher, [PRIMARY_RELAY, FALLBACK_RELAY], link);
  assert.equal(got.place, "Suryapet");
  assert.equal(got._sg, undefined);
  assert.equal(trustedPubFor(CODE), b64(traveller.pub));
  assert.ok(await pubMatchesLink(trustedPubFor(CODE), link));
  assert.equal(notFromPhoneCount(CODE), 2);
  // Later reads (since=<id>) keep dropping them, and the count does not grow for the same ones.
  await r.add(FALLBACK_RELAY, JSON.stringify({ km: 97, place: "FAKE3" }), link);
  assert.equal((await latest(CODE, "spot", "3h", r.fetcher, [PRIMARY_RELAY, FALLBACK_RELAY], link)).place, "Suryapet");
  assert.equal(notFromPhoneCount(CODE), 3);
});

test("journeys from 1.6.8 and older, and code-only links, read as before", async () => {
  resetReads();
  resetTrust();
  const old = Uint8Array.from(crypto.randomBytes(16));
  const r = relays();
  await r.add(FALLBACK_RELAY, JSON.stringify({ km: 7 }), old);
  assert.equal((await latest(CODE, "spot", "3h", r.fetcher, [PRIMARY_RELAY, FALLBACK_RELAY], old)).km, 7);
  assert.equal(notFromPhoneCount(CODE), 0);
  resetReads();
  const r2 = relays();
  const w = writer(crypto.randomBytes(32));
  await r2.add(PRIMARY_RELAY, w.sign("spot", { km: 8 }), null);
  assert.equal((await latest(CODE, "spot", "3h", r2.fetcher, [PRIMARY_RELAY, FALLBACK_RELAY], null)).km, 8, "code only: signed read as before");
});
