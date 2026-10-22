// Hushmile web viewer. Reads a journey from ntfy.sh and decrypts it in the
// browser. The trip code comes from the URL fragment (#ABCD-EFGH), which
// browsers never send to the web server. Same steps as lib/seal.dart.

import { STRINGS } from "./i18n.js";

// ---- Language (same words as the app: lib/l10n/*.arb) ----------------------

let lang = "en";
export const LANGUAGES = ["en", "te", "hi"];
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
export const RELAY = "https://ntfy.sh";

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

export function keysFor(code) {
  const bare = bareCode(code);
  if (!cache.has(bare)) {
    cache.set(bare, (async () => {
      const base = await subtle.importKey("raw", enc.encode(bare), "PBKDF2", false, ["deriveBits"]);
      const master = new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(KDF_SALT), iterations: KDF_ROUNDS }, base, 256));
      return { key: await hmac(master, "key"), seed: await hmac(master, "topic") };
    })());
  }
  return cache.get(bare);
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function topicFor(code, kind) {
  const { seed } = await keysFor(code);
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

async function aesKey(code, usage) {
  const { key } = await keysFor(code);
  return subtle.importKey("raw", key, { name: "AES-GCM" }, false, [usage]);
}

export async function sealFor(code, kind, plain) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const box = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(`${KDF_SALT}:${kind}`) }, await aesKey(code, "encrypt"), enc.encode(plain)));
  const out = new Uint8Array(1 + 12 + box.length);
  out[0] = SEAL_VERSION;
  out.set(nonce, 1);
  out.set(box, 13);
  return toB64url(out);
}

/** Null for a wrong code, a wrong kind, or changed text. */
export async function openFor(code, kind, sealed) {
  try {
    const raw = fromB64url(sealed);
    if (raw.length < 29 || raw[0] !== SEAL_VERSION) return null;
    const clear = await subtle.decrypt({ name: "AES-GCM", iv: raw.slice(1, 13), additionalData: enc.encode(`${KDF_SALT}:${kind}`) }, await aesKey(code, "decrypt"), raw.slice(13));
    return dec.decode(clear);
  } catch {
    return null;
  }
}

/** Newest readable message on a channel, parsed, or null. */
export async function latest(code, kind, since = "3h", fetcher = globalThis.fetch) {
  const topic = await topicFor(code, kind);
  const res = await fetcher(`${RELAY}/${topic}/json?poll=1&since=${since}`);
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const text = await res.text();
  let best = null;
  let order = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.event !== "message" || typeof event.message !== "string") continue;
    const plain = await openFor(code, kind, event.message);
    if (plain == null) continue;
    let body;
    try { body = JSON.parse(plain); } catch { continue; }
    const at = [event.time || 0, order++];
    if (body && typeof body === "object" && typeof event.time === "number") body.relayAt = event.time * 1000;
    if (!best || at[0] > best.at[0] || (at[0] === best.at[0] && at[1] > best.at[1])) best = { at, body };
  }
  return best ? best.body : null;
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
  return { name: body.name || t.webDriver(), from: body.from || "", to: body.to || "", start: Number(body.start) || 0, totalKm: total, speedKmh: speed };
}

// ---- The sentence (a port of lib/assurance.dart, family side) ---------------

/** Same as clockFor in lib/lang.dart: Telugu AM/PM, English and Hindi am/pm. */
export function clock(ms) {
  const d = new Date(ms);
  const h = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  const pm = d.getHours() >= 12;
  const mark = lang === "te" ? (pm ? "PM" : "AM") : pm ? "pm" : "am";
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

export function delayReason({ stillMin, stopsMin, paceKmh, plannedKmh, driverSaid }) {
  if (driverSaid === "traffic") return t.rsTraffic();
  if (driverSaid === "food" || driverSaid === "break") return t.rsBreak();
  if (driverSaid === "fuel") return t.rsFuel();
  if (stillMin >= 10) return t.rsStopped({ n: stillMin });
  if (paceKmh != null && plannedKmh > 0 && paceKmh < plannedKmh * 0.8) return t.rsSlow({ pace: paceKmh, plan: Math.round(plannedKmh) });
  if (stopsMin >= 10) return t.rsStops({ n: stopsMin });
  return null;
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
export function viewState({ trip, spot, dead, now = Date.now(), closedTrip = false }) {
  const name = trip ? trip.name : t.webDriver();
  const to = trip ? trip.to : t.webDestination();
  if (!spot || typeof spot.km !== "number") {
    if (closedTrip || (spot && spot.revoked)) return { title: "Tracking stopped", tone: "quiet", sentence: spot && spot.arrived ? t.jsArrived({ name }) : t.webEnded(), lastUpdate: null, kmLeft: null, battery: null, charging: false };
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
  const out = (title, tone, sentence, live = false) => ({ title, tone, sentence: live ? sentence + low : sentence, lastUpdate: at, kmLeft, battery, charging });
  if (spot.revoked || spot.interrupt === "closed") {
    return spot.arrived ? out("Arrived safely", "calm", t.jsArrived({ name })) : out("Tracking stopped", "quiet", t.jsEndedEarly());
  }
  if (spot.checkin === "help" || (spot.sos === true && spot.checkin !== "safe")) return out("Needs help", "help", place ? t.jsHelpAt({ name, place }) : t.jsHelp({ name }));
  if (spot.paused) return out("Sharing paused", "quiet", t.jsPaused({ name }));
  const stale = at != null && now - at >= staleAfter(Number(spot.every) || 0);
  if (stale) {
    const deadSays = deadAlertApplies(dead, spot);
    if (now - at >= noUpdateAfter(Number(spot.every) || 0) || deadSays) return out("Signal gap", "quiet", deadPhoneLine({ lastAt: at, place, battery, kmLeft }));
    return out("Signal gap", "quiet", place ? t.jsGapAt({ dead: "", place, at: clock(at) }) : t.jsGap({ dead: "", at: clock(at) }));
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
    const why = delayReason({ stillMin, stopsMin: Number(spot.stopsMin) || 0, paceKmh: typeof spot.paceKmh === "number" ? Math.round(spot.paceKmh) : null, plannedKmh: speed, driverSaid: said }) || (said ? `${checkinLabel(said)}.` : t.jsNoReason());
    if (late > 25) return out("At risk", "checkin", `${lead}${t.jsRiskReason({ past: t.jsRiskPast({ n: late }), reason: why, where: place || clock(at) })}`, true);
    return out("Delayed", "calm", `${lead}${t.jsLate({ late, why, rest: minutes ? t.jsMinRest({ m: minutes }) : "" })}`, true);
  }
  if (said) return out("On track", "calm", `${lead}${t.jsBecause({ because: checkinLabel(said) })}`, true);
  return out("On track", "calm", `${lead}${minutes ? t.jsOnScheduleMin({ m: minutes }) : t.jsOnSchedule()}`, true);
}

// ---- Page ------------------------------------------------------------------

export async function load(code, fetcher = globalThis.fetch, now = Date.now()) {
  const [tripBody, spot, dead] = await Promise.all([latest(code, "trip", "12h", fetcher), latest(code, "spot", "3h", fetcher), latest(code, "dead", "3h", fetcher).catch(() => null)]);
  const trip = readTrip(tripBody);
  if (!trip && !spot) return null;
  return viewState({ trip, spot, dead, now, closedTrip: Boolean(tripBody && tripBody.revoked) });
}
