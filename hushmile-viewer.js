// Hushmile web viewer. Reads a journey from Hushmile's relay and ntfy.sh and decrypts it in the
// browser. The trip code (and, from app 1.4.1, the journey's link key) comes
// from the URL fragment (#ABCD-EFGH or #ABCD-EFGH.KEY), which browsers never
// send to the web server. Same steps as lib/seal.dart.

import { LANGUAGE_INFO, STRINGS } from "./i18n.js";
import { SAFETY } from "./safety-config.js";

// ---- Language (same words as the app: lib/l10n/*.arb) ----------------------

let lang = "en";
/** From the app's language table (lib/lang.dart), through tool/arb_to_js.py. */
export const LANGUAGES = Object.keys(LANGUAGE_INFO);
export function setLanguage(code) {
  lang = LANGUAGES.includes(code) ? code : "en";
  return lang;
}
export const language = () => lang;

/** A saved choice wins; otherwise the first browser language Hushmile speaks. */
export function pickLanguage(saved, preferred = []) {
  if (LANGUAGES.includes(saved)) return saved;
  for (const item of preferred) {
    const code = String(item || "").toLowerCase().split("-")[0];
    if (LANGUAGES.includes(code)) return code;
  }
  return "en";
}

/** t.key({name: ...}) in the current language, English if a key is missing. */
export const t = new Proxy({}, { get: (_, key) => (args) => (STRINGS[lang][key] || STRINGS.en[key])(args) });

export const KDF_ROUNDS = 150000;
export const KDF_SALT = "hushmile-v2";
export const SEAL_VERSION = 2;
// Journey format 3 (app 1.4.1): a random 128-bit link key, after a dot in the
// link (#ABCD-EFGH.KEY), mixed into the keys and channels. Links with only the
// code ask Hushmile's server for the key (sealed with the code; rate-limited
// there). Format 2 journeys (older apps) are still read. See the app's
// docs/LINK_KEY.md.
export const LINK_SEAL_VERSION = 3;
// Relays (app 1.3.0+): Hushmile's own ntfy server first, ntfy.sh as the
// fallback. The app writes each message to exactly one of them (ntfy.sh only
// when ours does not take it), so the viewer reads both and keeps the newest,
// the same "write one, read both" rule as the app (lib/relay.dart).
export const PRIMARY_RELAY = "https://api.hushmile.com";
export const FALLBACK_RELAY = "https://ntfy.sh";
export const RELAYS = [PRIMARY_RELAY, FALLBACK_RELAY];
/** @deprecated kept for older callers: the fallback relay. */
export const RELAY = FALLBACK_RELAY;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export function bareCode(code) {
  return String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function shownCode(code) {
  const bare = bareCode(code);
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}

async function hmac(keyBytes, text) {
  const key = await subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", key, enc.encode(text)));
}

const cache = new Map();
const masters = new Map();
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function masterFor(bare) {
  if (!masters.has(bare)) {
    masters.set(bare, (async () => {
      const base = await subtle.importKey("raw", enc.encode(bare), "PBKDF2", false, ["deriveBits"]);
      return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(KDF_SALT), iterations: KDF_ROUNDS }, base, 256));
    })());
  }
  return masters.get(bare);
}

/** With link (16 bytes), the format 3 keys for that link key. */
export function keysFor(code, link = null) {
  const bare = bareCode(code);
  const tag = link ? `${bare}|${hex(link)}` : bare;
  if (!cache.has(tag)) {
    cache.set(tag, (async () => {
      const master = await masterFor(bare);
      if (!link) return { key: await hmac(master, "key"), seed: await hmac(master, "topic") };
      return { key: await hmac(master, `key3:${hex(link)}`), seed: await hmac(master, `topic3:${hex(link)}`) };
    })());
  }
  return cache.get(tag);
}

export async function topicFor(code, kind, link = null) {
  const { seed } = await keysFor(code, link);
  return "h" + hex(await hmac(seed, "topic:" + kind)).slice(0, 32);
}

function fromB64url(text) {
  const clean = String(text).trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "===".slice((clean.length + 3) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function toB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function aesKey(code, usage, link = null) {
  const { key } = await keysFor(code, link);
  return subtle.importKey("raw", key, { name: "AES-GCM" }, false, [usage]);
}

export function linkKeyText(bytes) {
  return toB64url(bytes);
}

/** The 22 character text form back to 16 bytes; null when it is not one. */
export function linkKeyFromText(text) {
  const clean = String(text || "").trim();
  if (!/^[A-Za-z0-9_-]{22}$/.test(clean)) return null;
  try {
    const bytes = fromB64url(clean);
    return bytes.length === 16 ? bytes : null;
  } catch {
    return null;
  }
}

/** "#ABCD-EFGH", "#ABCD-EFGH.KEY", a pasted link or a typed code: {code, key}. */
export function readInput(raw) {
  let text = String(raw || "").trim();
  try { text = decodeURIComponent(text); } catch {}
  const hash = text.lastIndexOf("#");
  if (hash >= 0) text = text.slice(hash + 1);
  const dot = text.indexOf(".");
  const code = shownCode(dot >= 0 ? text.slice(0, dot) : text);
  const key = dot >= 0 ? linkKeyFromText(text.slice(dot + 1)) : null;
  return { code, key };
}

export const KEY_API = `${PRIMARY_RELAY}/v1/key`;

// ---- Link-key escrow v2 (lib/linkkey.dart, docs/LINK_KEY.md) ---------------
// Only for a journey followed with just the spoken code. The server keeps the
// link key wrapped with scrypt(code, a salt for this journey); the id is
// scrypt(code, a fixed salt). Never a usable key: opening it needs the code.
export const ESCROW_N = 16384;
export const ESCROW_R = 8;
export const ESCROW_P = 1;
export const ESCROW_ID_SALT = "hushmile/escrow-id/v2";
export const KEY_LOOK_AGAIN_MS = 4 * 60000; // the server allows 1 lookup per 3 min after a burst
export const SEEN_EVERY_MS = 5 * 60000;
let escrowCost = ESCROW_N;
/** Tests: a cheaper scrypt (the real cost is pinned by the vector test). */
export function setEscrowCost(n) { escrowCost = n; escrowIds.clear(); }

async function pbkdf2once(password, salt, length) {
  const base = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1 }, base, length * 8));
}

function salsa8(s) {
  const x = Uint32Array.from(s);
  const R = (a, b) => (a << b) | (a >>> (32 - b));
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) s[i] = (s[i] + x[i]) >>> 0;
}

function blockMix(b, y, t, r) {
  t.set(b.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let w = 0; w < 16; w++) t[w] ^= b[i * 16 + w];
    salsa8(t);
    y.set(t, (i >> 1) * 16 + (i & 1) * r * 16);
  }
  b.set(y);
}

/** scrypt (RFC 7914); the same as lib/scrypt.dart. */
export async function scrypt(password, salt, n = ESCROW_N, r = ESCROW_R, p = ESCROW_P, length = 32) {
  const words = 32 * r;
  const b = await pbkdf2once(password, salt, p * 128 * r);
  const view = new DataView(b.buffer);
  const v = new Uint32Array(n * words);
  const x = new Uint32Array(words);
  const y = new Uint32Array(words);
  const t = new Uint32Array(16);
  for (let i = 0; i < p; i++) {
    for (let w = 0; w < words; w++) x[w] = view.getUint32((i * words + w) * 4, true);
    for (let k = 0; k < n; k++) { v.set(x, k * words); blockMix(x, y, t, r); }
    for (let k = 0; k < n; k++) {
      const base = (x[(2 * r - 1) * 16] & (n - 1)) * words;
      for (let w = 0; w < words; w++) x[w] ^= v[base + w];
      blockMix(x, y, t, r);
    }
    for (let w = 0; w < words; w++) view.setUint32((i * words + w) * 4, x[w], true);
  }
  return pbkdf2once(password, b, length);
}

const escrowIds = new Map();

/** Where the server keeps this journey's wrapped link key (lib/linkkey.dart escrowId). */
export function escrowId(code) {
  const bare = bareCode(code);
  if (!escrowIds.has(bare)) escrowIds.set(bare, scrypt(enc.encode(bare), enc.encode(ESCROW_ID_SALT), escrowCost).then((out) => hex(out.slice(0, 16))));
  return escrowIds.get(bare);
}

async function wrapKeyFor(code, salt) {
  const raw = await scrypt(enc.encode(bareCode(code)), salt, escrowCost);
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** The box the traveller's phone stores (tests; the viewer only opens boxes). */
export async function wrapLinkKey(code, key) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const box = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(`hushmile-escrow-v2:${await escrowId(code)}`) }, await wrapKeyFor(code, salt), enc.encode(linkKeyText(key))));
  const out = new Uint8Array(12 + box.length);
  out.set(nonce);
  out.set(box, 12);
  return { salt: toB64url(salt), box: toB64url(out) };
}

/** The link key from a server box, or null when it does not open with this code. */
export async function unwrapLinkKey(code, got) {
  try {
    const salt = fromB64url(got.salt);
    const all = fromB64url(got.box);
    if (salt.length !== 16 || all.length < 29) return null;
    const clear = await subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), additionalData: enc.encode(`hushmile-escrow-v2:${await escrowId(code)}`) }, await wrapKeyFor(code, salt), all.slice(12));
    return linkKeyFromText(dec.decode(clear));
  } catch {
    return null;
  }
}

const keyLookups = new Map();
// While the route itself cannot be read (a format 3 journey, code only), ask
// again on the next refresh, up to this many times. That sits inside the
// server's burst of 10. After that the 4 minute cache applies, so a page left
// open for hours does not knock on the key server every minute.
const keyWaitTries = new Map();
const KEY_WAIT_TRIES = 6;

/** Family with only the code: the journey's link key from Hushmile's server,
 * or null: no box yet (an older journey, or the traveller's phone has not seen
 * this page yet; asked again after KEY_LOOK_AGAIN_MS), or no answer (asked
 * again on the next refresh). A found key is kept for the page. */
export function lookUpLinkKey(code, fetcher = globalThis.fetch, now = Date.now()) {
  const bare = bareCode(code);
  const had = keyLookups.get(bare);
  if (had && (had.found || now - had.at < KEY_LOOK_AGAIN_MS)) return had.promise;
  const entry = { at: now, found: false, promise: null };
  entry.promise = (async () => {
    try {
      const res = await fetcher(`${KEY_API}?id=${await escrowId(code)}`);
      if (!res.ok) {
        if (res.status !== 404) keyLookups.delete(bare); // busy: ask again next minute
        return null;
      }
      const body = await res.json();
      const key = typeof body.box === "string" && typeof body.salt === "string" ? await unwrapLinkKey(code, body) : null;
      entry.found = Boolean(key);
      return key;
    } catch {
      keyLookups.delete(bare);
      return null;
    }
  })();
  keyLookups.set(bare, entry);
  return entry.promise;
}

const seenSent = new Map();

/** A code-only page says "someone is watching" on the old channel (as an old
 * app does), at most every SEEN_EVERY_MS: the traveller's phone then writes
 * the old channel too and escrows the link key for this page. */
export async function noteSeen(code, fetcher = globalThis.fetch, now = Date.now(), relays = RELAYS) {
  const bare = bareCode(code);
  if (now - (seenSent.get(bare) || 0) < SEEN_EVERY_MS) return false;
  seenSent.set(bare, now);
  const body = await sealFor(code, "seen", JSON.stringify({ seen: true, at: now }));
  const topic = await topicFor(code, "seen");
  for (const relay of relays) {
    try {
      // text/plain, no custom header: no CORS preflight. firebase=no as the app sends.
      const res = await fetcher(`${relay}/${topic}?firebase=no`, { method: "POST", body });
      if (res.ok) return true;
    } catch {}
  }
  seenSent.delete(bare);
  return false;
}

export async function sealFor(code, kind, plain, link = null) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const box = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(`${KDF_SALT}:${kind}`) }, await aesKey(code, "encrypt", link), enc.encode(plain)));
  const out = new Uint8Array(1 + 12 + box.length);
  out[0] = link ? LINK_SEAL_VERSION : SEAL_VERSION;
  out.set(nonce, 1);
  out.set(box, 13);
  return toB64url(out);
}

/** Null for a wrong code, a wrong kind, or changed text. */
export async function openFor(code, kind, sealed, link = null) {
  try {
    const raw = fromB64url(sealed);
    if (raw.length < 29 || raw[0] !== (link ? LINK_SEAL_VERSION : SEAL_VERSION)) return null;
    const clear = await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(1, 13), additionalData: enc.encode(`${KDF_SALT}:${kind}`) }, await aesKey(code, "decrypt", link), raw.slice(13));
    return dec.decode(clear);
  } catch {
    return null;
  }
}

// ---- Journey write key (app 1.6.9, the app's docs/WRITE_KEY.md) ------------
// The traveller's phone signs every point, route, dead-phone alert and end
// with a key that never leaves it; the link key commits to its public half
// (k = SHA-256("hushmile/link-pub/v1" | pub)[0:16]). This page holds the link
// (code + link key), so it can seal a message, but not sign one. A message
// signed by the proven key is kept; once a journey's key is proven, an
// unsigned or wrongly signed one is dropped. Journeys from 1.6.8 and older
// carry no signature and read as before. "seen" is never signed.
const WRITE_KEY_CONTEXT = "hushmile/link-pub/v1";
const MESSAGE_SIG_CONTEXT = "hushmile-sig-v1";
const SIGNED_TAIL = /,?"_pk":"([A-Za-z0-9_-]{43})","_sg":"([A-Za-z0-9_-]{86})"\}$/;
const SIG_PLACEHOLDER = "A".repeat(86);
const trustedPubs = new Map(); // bare code -> proven public key (base64url)
const notFromPhone = new Map(); // bare code -> Set of dropped messages
const sigChecks = new Map(); // kind + text -> check, bounded

export async function linkKeyForPub(pub) {
  const all = new Uint8Array(enc.encode(WRITE_KEY_CONTEXT).length + pub.length);
  all.set(enc.encode(WRITE_KEY_CONTEXT));
  all.set(pub, all.length - pub.length);
  return new Uint8Array(await subtle.digest("SHA-256", all)).slice(0, 16);
}

export async function pubMatchesLink(pubText, link) {
  if (!link) return false;
  let pub;
  try { pub = fromB64url(pubText); } catch { return false; }
  if (pub.length !== 32) return false;
  const k = await linkKeyForPub(pub);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= k[i] ^ link[i];
  return link.length === 16 && diff === 0;
}

/** Ed25519 verify: the browser's own WebCrypto when it has Ed25519, else the
 * bundled TweetNaCl (vendor/nacl.min.js). null when neither is available. */
export async function verifyEd25519(pub, sig, msg) {
  try {
    const key = await subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify({ name: "Ed25519" }, key, sig, msg);
  } catch {}
  const nacl = globalThis.nacl;
  if (nacl && nacl.sign && nacl.sign.detached) return nacl.sign.detached.verify(msg, sig, pub);
  return null;
}

/** {state: "unsigned"|"valid"|"broken"|"unknown", pub, clean}. */
export async function checkSigned(kind, plain) {
  const cacheKey = `${kind}\n${plain}`;
  if (sigChecks.has(cacheKey)) return sigChecks.get(cacheKey);
  const result = await checkSignedOnce(kind, plain);
  if (sigChecks.size >= 600) sigChecks.delete(sigChecks.keys().next().value);
  sigChecks.set(cacheKey, result);
  return result;
}

async function checkSignedOnce(kind, plain) {
  if (!plain.includes('"_sg"') && !plain.includes('"_pk"')) return { state: "unsigned" };
  const tail = SIGNED_TAIL.exec(plain);
  if (!tail) return { state: "broken" };
  let body;
  try { body = JSON.parse(plain); } catch { return { state: "broken" }; }
  if (!body || typeof body !== "object" || body._pk !== tail[1] || body._sg !== tail[2]) return { state: "broken" };
  let pub, sig;
  try { pub = fromB64url(tail[1]); sig = fromB64url(tail[2]); } catch { return { state: "broken" }; }
  if (pub.length !== 32 || sig.length !== 64) return { state: "broken" };
  const base = `${plain.slice(0, plain.length - 88)}${SIG_PLACEHOLDER}"}`;
  const ok = await verifyEd25519(pub, sig, enc.encode(`${MESSAGE_SIG_CONTEXT}\n${kind}\n${base}`));
  if (ok === false) return { state: "broken" };
  delete body._pk;
  delete body._sg;
  return { state: ok ? "valid" : "unknown", pub: tail[1], clean: body };
}

function dropped(code, kind, plain) {
  const bare = bareCode(code);
  if (!notFromPhone.has(bare)) notFromPhone.set(bare, new Set());
  const seen = notFromPhone.get(bare);
  if (seen.size < 600) seen.add(`${kind}\n${plain}`);
}

/** Updates dropped for this journey because they did not come from the traveller's phone. */
export function notFromPhoneCount(code) {
  return notFromPhone.get(bareCode(code))?.size || 0;
}

export function trustedPubFor(code) {
  return trustedPubs.get(bareCode(code)) || null;
}

/** Tests: forget proven keys and dropped updates. */
export function resetTrust() {
  trustedPubs.clear();
  notFromPhone.clear();
  sigChecks.clear();
}

/** Newest readable message on a channel across all relays, parsed, or null.
 * Throws only when no relay answered. */
export async function latest(code, kind, since = "3h", fetcher = globalThis.fetch, relays = RELAYS, link = null) {
  if (link) {
    // Format 3 first; nothing there means a journey from an older app.
    const strong = await latestOn(code, kind, since, fetcher, relays, link);
    if (strong != null) return strong;
  }
  return latestOn(code, kind, since, fetcher, relays, null);
}

// After the first read of a channel, ask each relay only for what is newer
// than the last message seen (since=<id>), as the app does: a minute's poll
// is then a few bytes, not the whole window. Dead-phone alerts always read
// the window, because a cancelled alert must disappear.
const reads = new Map(); // relay|topic -> {lastId, best}
// A relay that answered 429/503 is left alone for its Retry-After (when the
// browser may read it), else a doubling backoff from 15 s, capped at 10 min.
const resting = new Map(); // relay -> {until, strikes}
export const BUSY_BASE_MS = 15000;
export const BUSY_MAX_MS = 600000;

export function busyWaitMs(retryAfter, strikes, now = Date.now()) {
  const text = String(retryAfter ?? "").trim();
  let told = null;
  if (/^\d+$/.test(text)) told = Number(text) * 1000;
  else if (text) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) told = Math.max(0, at - now);
  }
  const wait = told ?? BUSY_BASE_MS * 2 ** Math.min(5, strikes) + Math.floor(Math.random() * BUSY_BASE_MS);
  return Math.min(BUSY_MAX_MS, wait);
}

export function relayResting(relay, now = Date.now()) {
  const r = resting.get(relay);
  return Boolean(r && now < r.until);
}

// The first relay time of each message, by channel and plain text. A copy of
// an old signed update posted again (anyone holding the link can re-post a
// sealed message on ntfy.sh) keeps the time it first arrived, so it can never
// look newer or fresher than it is. The app does the same (mergeRelayReads).
const firstSeen = new Map(); // topic|plain -> relay time (s)
const FIRST_SEEN_MAX = 4000;

export function firstRelayTime(topic, plain, time) {
  const key = `${topic}|${plain}`;
  const known = firstSeen.get(key);
  if (typeof time !== "number") return known ?? 0;
  if (known != null && known <= time) return known;
  firstSeen.set(key, time);
  if (firstSeen.size > FIRST_SEEN_MAX) firstSeen.delete(firstSeen.keys().next().value);
  return time;
}

/** Tests: forget incremental reads and resting relays. */
export function resetReads() {
  reads.clear();
  resting.clear();
  firstSeen.clear();
}

const newer = (a, b) => a && (!b || a.at[0] > b.at[0] || (a.at[0] === b.at[0] && a.at[1] > b.at[1]));

async function latestOn(code, kind, since, fetcher, relays, link) {
  const topic = await topicFor(code, kind, link);
  const awake = relays.filter((relay) => !relayResting(relay));
  const answers = await Promise.allSettled((awake.length ? awake : relays).map((relay) => readRelay(relay, topic, code, kind, since, fetcher, link)));
  const ok = answers.filter((a) => a.status === "fulfilled").map((a) => a.value);
  if (!ok.length) throw answers[0].reason || new Error("relay");
  // Decide after every relay answered: one may hold the proof the other lacks.
  const trusted = link ? trustedPubs.get(bareCode(code)) : null;
  let best = null;
  for (const found of ok) {
    if (!found) continue;
    if (trusted) {
      if (found.byPub.has(trusted) && newer(found.byPub.get(trusted), best)) best = found.byPub.get(trusted);
      if (found.unsigned) dropped(code, kind, found.unsigned.plain);
    } else {
      // No proven key: as before (a journey from an older app, or no link key).
      if (newer(found.unsigned, best)) best = found.unsigned;
      if (!link) for (const item of found.byPub.values()) if (newer(item, best)) best = item;
    }
  }
  return best ? best.body : null;
}

async function readRelay(relay, topic, code, kind, since, fetcher, link) {
  const key = `${relay}|${topic}`;
  const kept = kind === "dead" ? null : reads.get(key);
  const res = await fetcher(`${relay}/${topic}/json?poll=1&since=${encodeURIComponent(kept && kept.lastId ? kept.lastId : since)}`);
  if (res.status === 429 || res.status === 503) {
    const prev = resting.get(relay) || { strikes: 0 };
    const header = res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null;
    resting.set(relay, { until: Date.now() + busyWaitMs(header, prev.strikes), strikes: prev.strikes + 1 });
  }
  if (!res.ok) throw new Error(`relay ${res.status}`);
  resting.delete(relay);
  const text = await res.text();
  // The newest unsigned message, and the newest per signing key.
  let unsigned = kept ? kept.unsigned : null;
  const byPub = new Map(kept ? kept.byPub : []);
  let order = kept ? kept.order : 0;
  let lastId = null;
  let allIds = true;
  const bare = bareCode(code);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event !== "message" || typeof event.message !== "string") continue;
    if (typeof event.id === "string") lastId = event.id;
    else allIds = false;
    const plain = await openFor(code, kind, event.message, link);
    if (plain == null) continue;
    let body;
    try { body = JSON.parse(plain); } catch { continue; }
    const check = kind === "seen" ? { state: "unsigned" } : await checkSigned(kind, plain);
    if (check.state === "broken") { dropped(code, kind, plain); continue; }
    if (check.state === "valid") {
      body = check.clean;
      if (link && !trustedPubs.has(bare) && await pubMatchesLink(check.pub, link)) trustedPubs.set(bare, check.pub);
      if (link && !(await pubMatchesLink(check.pub, link))) { dropped(code, kind, plain); continue; }
    } else if (check.state === "unknown") {
      // This browser cannot check a signature (no Ed25519 at all): as before.
      body = check.clean;
    }
    const time = firstRelayTime(topic, plain, event.time);
    const at = [time, order++];
    if (body && typeof body === "object" && time > 0) body.relayAt = time * 1000;
    const item = { at, body, plain };
    if (check.state === "valid") {
      if (newer(item, byPub.get(check.pub))) byPub.set(check.pub, item);
    } else if (newer(item, unsigned)) unsigned = item;
  }
  if (kind !== "dead" && allIds && (lastId || kept)) reads.set(key, { lastId: lastId || kept.lastId, unsigned, byPub, order });
  return { unsigned, byPub };
}

// ---- Route -----------------------------------------------------------------

export function decodePoly(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    return (result & 1) ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function km(a, b) {
  const r = 6371, rad = Math.PI / 180;
  const dphi = (b[0] - a[0]) * rad, dl = (b[1] - a[1]) * rad;
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(Math.min(1, h)));
}

const VEHICLES = { bike: 0.72, car: 1, bus: 0.8, lorry: 0.62, truck: 0.55 };

export function readTrip(body) {
  if (!body || body.revoked) return null;
  const points = decodePoly(String(body.poly || ""));
  if (points.length < 2) return null;
  let total = 0;
  for (let i = 1; i < points.length; i++) total += km(points[i - 1], points[i]);
  const stops = Array.isArray(body.stops) ? body.stops : [];
  if (stops.length && typeof stops[stops.length - 1][3] === "number") total = stops[stops.length - 1][3];
  const speed = (Number(body.spd) || 60) * (VEHICLES[body.veh] || 1);
  return { name: body.name || t.webDriver(), from: body.from || "", to: body.to || "", start: Number(body.start) || 0, totalKm: total, speedKmh: speed, points };
}

// ---- Weak-signal stretches (same as lib/signal_map.dart) -------------------
// Cells (geohash-6, about 1.2 x 0.6 km) where five or more opted-in journeys
// lost signal, published by Hushmile's server. The viewer asks only for whole
// geohash-4 tiles (about 40 x 20 km) along the route, never the route itself,
// and only once the phone has gone quiet.

export const SIGNAL_API = `${PRIMARY_RELAY}/v1/signal`;
const GH = "0123456789bcdefghjkmnpqrstuvwxyz";

export function geohash(lat, lng, precision) {
  const la = [-90, 90], lo = [-180, 180];
  let out = "", bits = 0, ch = 0, even = true;
  while (out.length < precision) {
    const r = even ? lo : la, v = even ? lng : lat, mid = (r[0] + r[1]) / 2;
    ch <<= 1;
    if (v >= mid) { ch |= 1; r[0] = mid; } else r[1] = mid;
    even = !even;
    if (++bits === 5) { out += GH[ch]; bits = 0; ch = 0; }
  }
  return out;
}

export function tilesAlong(points) {
  return [...new Set(points.map(([lat, lng]) => geohash(lat, lng, 4)))].slice(0, 40);
}

const weakCache = new Map();

/** {cell: usual gap minutes} along these points; {} when the server does not answer. */
export async function weakCellsAlong(points, fetcher = globalThis.fetch) {
  const out = {};
  await Promise.all(tilesAlong(points).map(async (tile) => {
    try {
      const res = await fetcher(`${SIGNAL_API}?tile=${tile}`);
      if (!res.ok) return;
      const body = await res.json();
      for (const c of Array.isArray(body.cells) ? body.cells : []) {
        if (c && typeof c.g === "string" && typeof c.gap === "number") out[c.g] = c.gap;
      }
    } catch (_) { /* no weak-signal hint, nothing else changes */ }
  }));
  return out;
}

/** Weak cells for a trip, fetched once per page (kept 6 hours). */
export async function weakCellsForTrip(trip, fetcher = globalThis.fetch, now = Date.now()) {
  if (!trip || !Array.isArray(trip.points) || !trip.points.length) return {};
  const key = tilesAlong(trip.points).join(",");
  const saved = weakCache.get(key);
  if (saved && now - saved.at < 6 * 3600000) return saved.cells;
  const cells = await weakCellsAlong(trip.points, fetcher);
  weakCache.set(key, { at: now, cells });
  return cells;
}

/** Usual gap if the phone went quiet in, or just before, a weak cell; else null. */
export function weakNear(cells, { lat, lng, points, km: atKm, aheadKm = 12 } = {}) {
  if (!cells || !Object.keys(cells).length) return null;
  let best = null;
  const consider = (la, ln) => {
    const gap = cells[geohash(la, ln, 6)];
    if (typeof gap === "number" && (best == null || gap > best)) best = gap;
  };
  if (typeof lat === "number" && typeof lng === "number") consider(lat, lng);
  if (Array.isArray(points) && typeof atKm === "number") {
    let along = 0;
    for (let i = 0; i < points.length; i++) {
      if (i) along += km(points[i - 1], points[i]);
      if (along > atKm + aheadKm) break;
      if (along >= atKm - 1) consider(points[i][0], points[i][1]);
    }
  }
  return best;
}

// ---- The sentence (a port of lib/assurance.dart, family side) ---------------

/** Same as clockFor in lib/lang.dart: AM/PM where the table says so (Telugu,
 * Tamil, Kannada), am/pm otherwise. */
export function clock(ms) {
  const d = new Date(ms);
  const h = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  const pm = d.getHours() >= 12;
  const mark = LANGUAGE_INFO[lang]?.upperAmPm ? (pm ? "PM" : "AM") : pm ? "pm" : "am";
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${mark}`;
}

/** Same as nearMinutes in lib/arrival.dart. */
export function nearMinutes(distanceM, roadMin) {
  if (typeof roadMin === "number" && roadMin >= 0) return Math.max(1, Math.round(roadMin));
  return Math.max(1, Math.round((distanceM / 1000 / 25) * 60));
}

const staleAfter = (every) => Math.max(8 * 60000, every > 0 ? every * 1000 + 2 * 60000 : 0);
/** Same as noUpdateAfterMs in lib/budget.dart. */
export const noUpdateAfter = (every) => Math.max(20 * 60000, every > 0 ? 2 * every * 1000 + 2 * 60000 : 0);

// ---- Safety (1.4.2; same rules as lib/safety.dart, numbers from config/safety.json)

/** Night hours, in this browser's time zone. */
export function isNightHour(hour) {
  const { startHour: start, endHour: end } = SAFETY.night;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}
export const nightAt = (ms) => isNightHour(new Date(ms).getHours());

/** Same as nightQuietMs: a shorter silence limit when the last point came at night. */
export function nightQuiet(dayMs, pointAt) {
  if (pointAt == null || !nightAt(pointAt)) return dayMs;
  const shorter = Math.round(dayMs * SAFETY.night.quietScale);
  const night = Math.max(shorter, SAFETY.night.minQuietMin * 60000);
  return Math.min(night, dayMs);
}

/** "low" under 15%, "critical" under 5%, never while charging. */
export function batteryBand(spot) {
  if (!spot || spot.charging === true) return null;
  if (spot.battBand === "low" || spot.battBand === "critical") return spot.battBand;
  if (typeof spot.battery !== "number") return null;
  if (spot.battery < SAFETY.battery.criticalPct) return "critical";
  if (spot.battery < SAFETY.battery.lowPct) return "low";
  return null;
}

/** Minutes off the planned route, from a 1.4.2 phone's "offSince". */
export function offRouteMinutes(spot) {
  if (!spot || typeof spot.offSince !== "number" || spot.offSince <= 0 || typeof spot.updatedAt !== "number" || spot.updatedAt < spot.offSince) return null;
  return Math.floor((spot.updatedAt - spot.offSince) / 60000);
}

export function sosActive(spot) {
  if (!spot || spot.paused === true || spot.checkin === "safe") return false;
  return spot.checkin === "help" || spot.sosAt != null || spot.sos === true;
}

/** Same as exactPin in lib/route_find.dart. */
const pinText = (lat, lng) => `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? "E" : "W"}`;
export const mapPinUrl = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
export const mapSearchUrl = (what, lat, lng) => `https://www.google.com/maps/search/${encodeURIComponent(what)}/@${lat.toFixed(5)},${lng.toFixed(5)},13z`;
export const dialUrl = (number) => `tel:${String(number).replace(/[^0-9+]/g, "")}`;

/** The SOS banner: who, the exact last location and its age, and the links. */
export function sosBanner(spot, trip, now = Date.now()) {
  if (!sosActive(spot)) return null;
  const name = trip ? trip.name : t.webDriver();
  const ok = typeof spot.lat === "number" && typeof spot.lng === "number";
  const pin = ok ? pinText(spot.lat, spot.lng) : null;
  const place = typeof spot.place === "string" && spot.place.trim() ? spot.place.trim() : null;
  const where = pin == null ? place : place == null ? pin : `${place} (${pin})`;
  const fix = typeof spot.fixAt === "number" ? spot.fixAt : typeof spot.updatedAt === "number" ? spot.updatedAt : null;
  const age = fix == null ? null : now - fix < 60000 ? t.fixAgeNow() : t.fixAgeMin({ n: Math.floor((now - fix) / 60000) });
  const phone = typeof spot.phone === "string" && spot.phone.trim() ? spot.phone.trim() : null;
  return {
    title: t.sosPressed({ name }),
    body: where == null || age == null ? t.sosNoLocation() : t.sosBody({ where, age }),
    sub: t.sosBannerSub({ name }),
    call: phone ? { label: t.callName({ name }), href: dialUrl(phone) } : null,
    noPhone: phone ? null : t.noPhoneShared({ name }),
    map: ok ? { label: t.openMap(), href: mapPinUrl(spot.lat, spot.lng) } : null,
  };
}

/** Help on the route for the family: the country's numbers (config/safety.json)
 * and map searches near the vehicle's last position. Nothing is dialled by itself. */
export function helpLinks(spot, country = "in") {
  const c = SAFETY.countries[country] || SAFETY.countries.in;
  const label = { emergency: t.dialEmergency, ambulance: t.dialAmbulance, highway: t.dialHighway };
  const dial = (c.dial || []).map((n) => ({ label: `${(label[n.id] || t.dialOther)()} ${n.number}`, href: dialUrl(n.number) }));
  const ok = spot && typeof spot.lat === "number" && typeof spot.lng === "number";
  const search = ok
    ? [
        { label: t.webFindHospitals(), href: mapSearchUrl(t.webMapQueryHospital(), spot.lat, spot.lng) },
        { label: t.webFindPolice(), href: mapSearchUrl(t.webMapQueryPolice(), spot.lat, spot.lng) },
      ]
    : [];
  return { dial, search };
}

/** Same as cabLine in lib/safety.dart. */
export function cabLine(cab) {
  if (!cab || typeof cab !== "object") return null;
  const s = (v) => (typeof v === "string" ? v.trim() : "");
  const parts = [s(cab.operator), s(cab.plate) && t.cabPlateIs({ plate: s(cab.plate) }), s(cab.driver) && t.cabDriverIs({ name: s(cab.driver) })].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Same as dayAndClock in lib/lang.dart, from this browser's day. */
export function dayAndClock(at, now = Date.now()) {
  const a = new Date(at), n = new Date(now);
  const days = Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000);
  const time = clock(at);
  if (days === 0) return t.dayToday({ time });
  if (days === 1) return t.dayTomorrow({ time });
  if (days === -1) return t.dayYesterday({ time });
  const weekday = t.weekdaysShort().split(" ")[(a.getDay() + 6) % 7];
  const month = t.monthsShort().split(" ")[a.getMonth()];
  return t.dayOn({ weekday, day: String(a.getDate()), month, time });
}

/** Same rule as deadAlertApplies in lib/assurance.dart. */
export function deadAlertApplies(dead, spot) {
  if (!dead || typeof dead.lastAt !== "number") return false;
  if (spot && (spot.revoked || spot.interrupt === "closed" || spot.paused)) return false;
  const quiet = typeof dead.quietMs === "number" ? dead.quietMs : noUpdateAfter(Number(dead.every) || 0);
  const spotAt = spot ? (typeof spot.updatedAt === "number" ? spot.updatedAt : typeof spot.at === "number" ? spot.at : null) : null;
  let fired;
  let newest;
  if (typeof dead.relayAt === "number" && (!spot || typeof spot.relayAt === "number")) {
    fired = dead.relayAt;
    newest = spot ? spot.relayAt : null;
  } else {
    if (typeof dead.fireAt !== "number") return spotAt == null || spotAt <= dead.lastAt + 1000;
    fired = dead.fireAt;
    newest = spotAt;
  }
  if (newest == null) newest = dead.lastAt;
  return fired - newest >= quiet;
}
const CHECKIN = { ok: "ciOk", traffic: "ciTraffic", food: "ciFood", fuel: "ciFuel", break: "ciBreak", safe: "ciSafe", vehicle: "ciVehicle" };
const checkinLabel = (said) => (CHECKIN[said] ? t[CHECKIN[said]]() : said);

export function delayReason({ stillMin, stopsMin, paceKmh, plannedKmh, driverSaid, why = null, whyPlace = "", offKm = 0, stopPlace = "", stopKind = null }) {
  if (driverSaid === "traffic") return t.rsTraffic();
  if (driverSaid === "food" || driverSaid === "break") return t.rsBreak();
  if (driverSaid === "fuel") return t.rsFuel();
  // Traffic measured by Google on the traveller's phone (app 1.4.0), with the slow place.
  if (why === "traffic") return whyPlace ? t.rsTrafficNear({ place: whyPlace }) : t.rsTrafficRoute();
  // Heavy rain measured where the traveller is (app 1.4.1, Open-Meteo).
  if (why === "rain") return t.rsRain();
  // Waiting at a toll plaza is part of the road, not a stop.
  if (stillMin >= 10 && stopKind !== "toll") return stopPlace ? t.rsStoppedNear({ n: stillMin, place: stopPlace }) : t.rsStopped({ n: stillMin });
  if (paceKmh != null && plannedKmh > 0 && paceKmh < plannedKmh * 0.8) return t.rsSlow({ pace: paceKmh, plan: Math.round(plannedKmh) });
  if (offKm > 2 || why === "offroute") return t.rsOffRoute();
  if (stopsMin >= 10) return t.rsStops({ n: stopsMin });
  return null;
}

/** Road facts from app 1.4.0, each as of the last update: the road, the
 * route, a different route, a passenger's boarding state. Empty for older phones. */
/** "About 8 km past Narkatpalli" (app 1.4.1, lib/route_context.dart landmarkLine). */
export function landmarkLine(spot) {
  const name = spot && typeof spot.lm === "string" ? spot.lm.trim() : "";
  if (!name) return null;
  const k = typeof spot.lmKm === "number" ? spot.lmKm : null;
  const kmText = k == null ? null : k < 1 ? "1" : k < 10 ? String(Math.round(k * 10) / 10) : String(Math.round(k));
  if (spot.lmRel === "past" && kmText) return t.lmPast({ km: kmText, place: name });
  if (spot.lmRel === "before" && kmText) return t.lmBefore({ km: kmText, place: name });
  if (spot.lmRel === "near" && kmText) return t.lmNear({ km: kmText, place: name });
  return t.lmIn({ place: name });
}

/** Heavy rain where the traveller is, with its age (lib/route_context.dart rainLine). */
export const RAIN_SHOWN_FOR_MS = 90 * 60000;
export function rainLine(spot, now = Date.now()) {
  const at = spot && spot.rain && typeof spot.rain.at === "number" ? spot.rain.at : null;
  if (at == null || now - at > RAIN_SHOWN_FOR_MS) return null;
  return t.rainNote({ n: Math.max(0, Math.floor((now - at) / 60000)) });
}

/** "Taking a break, replied 2 min ago" (app 1.4.1, lib/assurance.dart repliedLine):
 * a reply from the app or from the check-in notification's buttons. */
const REPLY = { ok: "replyFine", break: "replyBreak", traffic: "replyTraffic" };
export function repliedLine(spot, now = Date.now()) {
  const said = spot && typeof spot.checkin === "string" ? spot.checkin : null;
  const at = spot && typeof spot.repliedAt === "number" ? spot.repliedAt : null;
  if (!said || at == null || said === "help" || said === "safe") return null;
  const what = REPLY[said] ? t[REPLY[said]]() : checkinLabel(said);
  const ago = now - at < 60000 ? t.speedJustNow() : t.minAgo({ n: Math.floor((now - at) / 60000) });
  return t.repliedAgo({ what, ago });
}

export function roadLines(spot, trip = null, now = Date.now()) {
  if (!spot) return [];
  const lines = [];
  const text = (k) => (typeof spot[k] === "string" ? spot[k].trim() : "");
  const replied = repliedLine(spot, now);
  if (replied) lines.push(replied);
  if (text("road")) lines.push(text("toward") ? t.roadOnTowards({ road: text("road"), place: text("toward") }) : t.roadOn({ road: text("road") }));
  if (spot.inArea === true) lines.push(t.endDetected());
  const near = landmarkLine(spot);
  if (near) lines.push(near);
  const rain = rainLine(spot, now);
  if (rain) lines.push(rain);
  const what = { fuel: t.stopFuel, food: t.stopFood, toll: t.stopToll }[spot.stopKind];
  if (what) lines.push(text("stopName") ? `${what()}: ${text("stopName")}` : what());
  const offMin = offRouteMinutes(spot);
  if (offMin != null) lines.push(t.offRouteFor({ n: offMin }));
  else if (!("offSince" in spot) && typeof spot.offKm === "number" && spot.offKm > 2) lines.push(t.offRouteNow());
  const band = batteryBand(spot);
  if (band === "critical") lines.push(t.battCriticalFamily({ pct: SAFETY.battery.criticalPct }));
  else if (band === "low") lines.push(t.battLowFamily());
  const cab = cabLine(spot.cab);
  if (cab) lines.push(cab);
  if (text("via")) lines.push(t.routeVia({ road: text("via") }));
  const board = text("board");
  if (board === "longwait") lines.push(t.psLongWait({ n: typeof spot.updatedAt === "number" && trip && trip.start ? Math.max(0, Math.floor((spot.updatedAt - trip.start) / 60000)) : 0 }));
  else if (board === "waiting") lines.push(t.psWaitingNow());
  else if (board === "onboard") lines.push(t.psOnBoard());
  else if (board === "onboardstopped") lines.push(t.psOnBoardStopped());
  return lines;
}

export function deadPhoneLine({ lastAt, place, battery, kmLeft }) {
  const where = place ? t.dpNear({ place }) : "";
  const left = kmLeft == null ? "" : t.dpLeft({ km: Math.round(kmLeft) });
  const power = battery == null ? t.dpOff() : battery <= 15 ? t.dpLowBattery({ n: battery }) : t.dpBattery({ n: battery });
  return t.dpLine({ at: clock(lastAt), where, left, power });
}

export function catchUpLine(back, at, place) {
  if (!back || typeof back.from !== "number" || at == null) return null;
  const minutes = Math.round((at - back.from) / 60000);
  const head = t.cuHead({ at: clock(at) });
  if (typeof back.n === "number" && back.n <= 0) return t.cuNone({ head, n: minutes });
  if (typeof back.km === "number" && back.km >= 1) return t.cuMoved({ head, km: Math.round(back.km) });
  return t.cuStayed({ head, near: place ? t.dpNear({ place }) : "", n: minutes });
}

/** {title, tone, sentence, lastUpdate, kmLeft, battery, charging} for what the family should read. */
// ---- How a journey ended (port of lib/journey_end.dart) ---------------------

const metresApart = (a, b) => km(a, b) * 1000;

/** Same as atDestination in lib/journey_end.dart (nearRadiusM in arrival.dart). */
function atDestination(trip, lat, lng, accuracyM) {
  if (!trip || !Array.isArray(trip.points) || !trip.points.length) return true;
  const end = trip.points[trip.points.length - 1];
  const radius = Math.min(800, Math.max(300, (trip.totalKm || 0) * 5));
  return metresApart([lat, lng], end) - Math.min(accuracyM, 100) <= radius;
}

/** The closing sentence: arrived only when confirmed at the destination;
 * otherwise who ended it, where and when; or that the code expired. */
export function endSentence(spot, trip, name, to) {
  const at = typeof spot.endAt === "number" ? spot.endAt : typeof spot.at === "number" ? spot.at : null;
  const place = typeof spot.endPlace === "string" && spot.endPlace ? spot.endPlace : typeof spot.place === "string" && spot.place ? spot.place : null;
  let reason = ["arrived", "ended", "expired", "detected"].includes(spot.end) ? spot.end : null;
  let saidArrived = spot.endSaid === "arrived";
  let away = typeof spot.endAwayKm === "number" ? spot.endAwayKm : null;
  if (!reason) {
    reason = spot.arrived ? "arrived" : "ended";
    // An older phone's "arrived" far from the destination is not an arrival.
    if (reason === "arrived" && typeof spot.lat === "number" && typeof spot.lng === "number" && trip && !atDestination(trip, spot.lat, spot.lng, 100)) {
      reason = "ended";
      saidArrived = true;
      const end = trip.points[trip.points.length - 1];
      away = metresApart([spot.lat, spot.lng], end) / 1000;
    }
  }
  if (reason === "arrived") return { arrived: true, sentence: t.jsArrived({ name }) };
  if (reason === "expired") return { arrived: false, sentence: t.jsExpired() };
  if (reason === "detected") return { arrived: false, sentence: at == null ? t.endDetected() : t.endDetectedLine({ name, to, time: clock(at) }) };
  if (at == null) return { arrived: false, sentence: spot.revoked ? t.webEnded() : t.jsEndedEarly() };
  if (saidArrived && away != null) return { arrived: false, sentence: t.endedSaidArrived({ name, time: clock(at), km: away < 10 ? away.toFixed(1) : String(Math.round(away)), to }) };
  if (place) return { arrived: false, sentence: t.endedNearAt({ name, place, time: clock(at) }) };
  return { arrived: false, sentence: t.endedAtTime({ name, time: clock(at) }) };
}

/** Speed at the last update and the average while moving (lib/speed.dart);
 * null for points from older phones. Shown with its age, never as live. */
export function speedLine(spot, now = Date.now()) {
  if (!spot || typeof spot.kmh !== "number" || !(spot.kmh >= 0) || spot.kmh > 400) return null;
  const at = typeof spot.kmhAt === "number" ? spot.kmhAt : typeof spot.updatedAt === "number" ? spot.updatedAt : null;
  const value = spot.kmh === 0 ? t.speedStopped() : t.speedNow({ kmh: Math.round(spot.kmh) });
  const ago = at == null ? null : now - at < 60000 ? t.speedJustNow() : t.minAgo({ n: Math.floor((now - at) / 60000) });
  const line = ago ? t.speedAt({ speed: value, ago }) : value;
  const avg = typeof spot.avgKmh === "number" && spot.avgKmh > 0 ? t.speedAvg({ kmh: Math.round(spot.avgKmh) }) : null;
  return avg ? `${line} · ${avg}` : line;
}

export function viewState({ trip, spot, dead, now = Date.now(), closedTrip = false, weak = null }) {
  const name = trip ? trip.name : t.webDriver();
  const to = trip ? trip.to : t.webDestination();
  if (!spot || typeof spot.km !== "number") {
    if (closedTrip || (spot && spot.revoked)) {
      const end = spot ? endSentence(spot, trip, name, to) : { arrived: false, sentence: t.webEnded() };
      return { title: end.arrived ? "Arrived safely" : "Tracking stopped", tone: end.arrived ? "calm" : "quiet", sentence: end.sentence, lastUpdate: null, kmLeft: null, battery: null, charging: false, speed: null };
    }
    return { title: "Waiting for a location", tone: "quiet", sentence: t.jsWaiting(), lastUpdate: null, kmLeft: trip ? trip.totalKm : null, battery: null, charging: false };
  }
  const at = typeof spot.updatedAt === "number" ? spot.updatedAt : null;
  const total = trip ? trip.totalKm : spot.km;
  const kmLeft = Math.max(0, total - spot.km);
  const place = typeof spot.place === "string" ? spot.place : null;
  const battery = typeof spot.battery === "number" ? Math.round(spot.battery) : null;
  const charging = spot.charging === true;
  // Under 10% and not charging: one calm warning on any live status.
  const low = battery != null && !charging && battery < 10 ? ` ${t.jsBatteryLow({ n: battery })}` : "";
  const closed = spot.revoked || spot.interrupt === "closed";
  const speedText = closed ? null : speedLine(spot, now);
  const roads = closed ? [] : roadLines(spot, trip, now);
  const sos = closed ? null : sosBanner(spot, trip, now);
  const help = closed ? null : helpLinks(spot);
  const out = (title, tone, sentence, live = false) => ({ title, tone, sentence: live ? sentence + low : sentence, lastUpdate: at, kmLeft: trip ? kmLeft : null, battery, charging, speed: speedText, roads, sos, help });
  if (closed) {
    const end = endSentence(spot, trip, name, to);
    return end.arrived ? out("Arrived safely", "calm", end.sentence) : out("Tracking stopped", "quiet", end.sentence);
  }
  if (spot.checkin === "help" || (spot.sos === true && spot.checkin !== "safe")) return out("Needs help", "help", place ? t.jsHelpAt({ name, place }) : t.jsHelp({ name }));
  if (spot.paused) return out("Sharing paused", "quiet", t.jsPaused({ name }));
  const stale = at != null && now - at >= staleAfter(Number(spot.every) || 0);
  if (stale) {
    // A gap where signal is usually weak reads as expected, not alarming.
    const weakGap = weakNear(weak, { lat: spot.lat, lng: spot.lng, points: trip && trip.points, km: spot.km });
    const expected = weakGap == null ? "" : ` ${t.weakHere({ n: weakGap })}`;
    const deadSays = deadAlertApplies(dead, spot);
    if (now - at >= nightQuiet(noUpdateAfter(Number(spot.every) || 0), at) || deadSays) {
      // Silence after a low battery is explained as such; night alerts come sooner.
      // deadPhoneLine already says it when the battery was 15% or less.
      const saidBattery = typeof battery === "number" && battery <= 15;
      const why = [batteryBand(spot) && !saidBattery ? ` ${t.quietLowBattery()}` : "", nightAt(at) ? ` ${t.nightSooner()}` : ""].join("");
      return out("Signal gap", "quiet", deadPhoneLine({ lastAt: at, place, battery, kmLeft }) + why + expected);
    }
    return out("Signal gap", "quiet", (place ? t.jsGapAt({ dead: "", place, at: clock(at) }) : t.jsGap({ dead: "", at: clock(at) })) + expected);
  }
  const back = catchUpLine(spot.back, at, place);
  const lead = back ? back + " " : "";
  // The driver phone's geofence decides; an older app falls back to 3 km.
  const near = typeof spot.near === "boolean" ? spot.near : kmLeft <= 3 && kmLeft > 0;
  if (near) {
    const metres = typeof spot.nearM === "number" ? spot.nearM : kmLeft * 1000;
    return out("Near the destination", "calm", `${lead}${t.jsAlmost({ n: nearMinutes(metres, spot.roadMin) })}`, true);
  }
  const stillMin = typeof spot.movedAt === "number" ? Math.max(0, Math.floor((now - spot.movedAt) / 60000)) : 0;
  const stopMin = [15, 30, 45].includes(spot.stopMin) ? spot.stopMin : 15;
  const said = typeof spot.checkin === "string" && spot.checkin !== "help" ? spot.checkin : null;
  if (stillMin >= stopMin && !said) return out("Check-in requested", "checkin", `${lead}${place ? t.jsStoppedLongAt({ place }) : t.jsStoppedLong()}`, true);
  const speed = trip ? trip.speedKmh : 60;
  const moveMin = typeof spot.roadMin === "number" ? spot.roadMin : (kmLeft / speed) * 60;
  const arrivesAt = trip && trip.start ? trip.start + (total / speed) * 3600000 : null;
  const late = arrivesAt ? Math.round((now + moveMin * 60000 - arrivesAt) / 60000) : 0;
  const minutes = moveMin >= 1 ? Math.round(moveMin) : null;
  if (late > 8) {
    const why = delayReason({ stillMin, stopsMin: Number(spot.stopsMin) || 0, paceKmh: typeof spot.paceKmh === "number" ? Math.round(spot.paceKmh) : null, plannedKmh: speed, driverSaid: said, why: typeof spot.why === "string" ? spot.why : null, whyPlace: typeof spot.whyPlace === "string" ? spot.whyPlace : "", offKm: typeof spot.offKm === "number" ? spot.offKm : 0, stopPlace: place || "", stopKind: typeof spot.stopKind === "string" ? spot.stopKind : null }) || (said ? `${checkinLabel(said)}.` : t.jsNoReason());
    if (late > 25) return out("At risk", "checkin", `${lead}${t.jsRiskReason({ past: t.jsRiskPast({ n: late }), reason: why, where: place || clock(at) })}`, true);
    return out("Delayed", "calm", `${lead}${t.jsLate({ late, why, rest: minutes ? t.jsMinRest({ m: minutes }) : "" })}`, true);
  }
  if (said) return out("On track", "calm", `${lead}${t.jsBecause({ because: checkinLabel(said) })}`, true);
  return out("On track", "calm", `${lead}${minutes ? t.jsOnScheduleMin({ m: minutes }) : t.jsOnSchedule()}`, true);
}

// ---- Page ------------------------------------------------------------------

/** What the map shows: the planned route, the recent trail and the last known
 * place with its time. Nothing that was not in the journey's own messages. */
export function mapData(trip, spot) {
  const route = trip && Array.isArray(trip.points) ? trip.points : [];
  const at = spot && typeof spot.updatedAt === "number" ? spot.updatedAt : null;
  const ok = (lat, lng) => typeof lat === "number" && typeof lng === "number" && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const trail = [];
  if (spot && Array.isArray(spot.trail) && at != null) {
    for (const p of spot.trail) {
      if (Array.isArray(p) && p.length >= 3 && ok(p[0], p[1]) && typeof p[2] === "number") trail.push([p[0], p[1], at - p[2] * 1000]);
    }
  }
  const last = spot && ok(spot.lat, spot.lng) && !spot.revoked ? { lat: spot.lat, lng: spot.lng, at } : null;
  // Heading (degrees) for the arrow and accuracy (metres) for the halo, when sent.
  if (last && typeof spot.hdg === "number" && Number.isFinite(spot.hdg)) last.hdg = spot.hdg;
  if (last && typeof spot.acc === "number" && spot.acc > 0 && spot.acc < 5000) last.acc = spot.acc;
  if (!route.length && !trail.length && !last) return null;
  return { route, trail, last };
}

/** "Last known place, 12 min ago" for the map marker. */
export function mapAgeLine(at, now = Date.now()) {
  if (at == null) return "";
  return t.mapLastKnown({ ago: t.minAgo({ n: Math.max(0, Math.floor((now - at) / 60000)) }) });
}

/** link: the key from the page's link; undefined means "ask the server". */
export async function load(code, fetcher = globalThis.fetch, now = Date.now(), link = undefined) {
  const asked = link === undefined;
  const key = asked ? await lookUpLinkKey(code, fetcher, now) : link;
  const [tripBody, spot, dead] = await Promise.all([latest(code, "trip", "12h", fetcher, RELAYS, key), latest(code, "spot", "3h", fetcher, RELAYS, key), latest(code, "dead", "3h", fetcher, RELAYS, key).catch(() => null)]);
  const trip = readTrip(tripBody);
  const closedTrip = Boolean(tripBody && tripBody.revoked);
  // Code only (no link key): tell the traveller's phone, so it writes points
  // the code can open and escrows the key for this page. Do this even when
  // nothing is readable yet. A format 3 journey keeps the route on the
  // link-key channel only, so returning here without "seen" means the phone
  // never learns this page is open.
  if (!key && !closedTrip) await noteSeen(code, fetcher, now).catch(() => false);
  if (!key && !trip && !closedTrip && asked) {
    const bare = bareCode(code);
    const n = (keyWaitTries.get(bare) || 0) + 1;
    keyWaitTries.set(bare, n);
    if (n <= KEY_WAIT_TRIES) keyLookups.delete(bare);
  }
  if (!trip && !spot && !closedTrip) {
    // A link that already carries the key, and still nothing: not this journey.
    if (key) return null;
    // Not started, or the driver's phone has not handed the key over yet.
    // Leave the page open; it checks again every minute.
    return { title: "Waiting", tone: "quiet", sentence: t.codeWaiting(), lastUpdate: null, kmLeft: null, battery: null, charging: false, speed: null, roads: [], waiting: true, map: null };
  }
  let state = viewState({ trip, spot, dead, now, closedTrip });
  // Only a quiet phone needs the weak-signal hint, so only then ask for it.
  if (trip && state.title === "Signal gap") {
    const weak = await weakCellsForTrip(trip, fetcher, now).catch(() => ({}));
    if (Object.keys(weak).length) state = viewState({ trip, spot, dead, now, closedTrip, weak });
  }
  state.map = mapData(trip, spot);
  // Something sealed with this journey's link but not signed by the
  // traveller's phone was dropped: say so, quietly.
  if (notFromPhoneCount(code) > 0) state.notFromPhone = t.webNotFromPhone({ name: (trip && trip.name) || "" });
  return state;
}
