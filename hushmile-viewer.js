// Hushmile web viewer. Reads a journey from ntfy.sh and decrypts it in the
// browser. The trip code comes from the URL fragment (#ABCD-EFGH), which
// browsers never send to the web server. Same steps as lib/seal.dart.

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
  return { name: body.name || "Driver", from: body.from || "", to: body.to || "", start: Number(body.start) || 0, totalKm: total, speedKmh: speed };
}

// ---- The sentence (a port of lib/assurance.dart, family side) ---------------

export function clock(ms) {
  const t = new Date(ms);
  const h = t.getHours() % 12 === 0 ? 12 : t.getHours() % 12;
  return `${h}:${String(t.getMinutes()).padStart(2, "0")} ${t.getHours() >= 12 ? "pm" : "am"}`;
}

const staleAfter = (every) => Math.max(8 * 60000, every > 0 ? every * 1000 + 2 * 60000 : 0);
const CHECKIN = { ok: "They are fine", traffic: "Traffic", food: "A food break", fuel: "Fuel or the vehicle", break: "A break", safe: "They said they are safe" };

export function delayReason({ stillMin, stopsMin, paceKmh, plannedKmh, driverSaid }) {
  if (driverSaid === "traffic") return "The driver said traffic.";
  if (driverSaid === "food" || driverSaid === "break") return "The driver is taking a break.";
  if (driverSaid === "fuel") return "The driver stopped for fuel.";
  if (stillMin >= 10) return `Stopped for ${stillMin} minutes, likely a break.`;
  if (paceKmh != null && plannedKmh > 0 && paceKmh < plannedKmh * 0.8) return `Moving slower than planned, about ${paceKmh} km/h against ${Math.round(plannedKmh)} planned.`;
  if (stopsMin >= 10) return `Stops so far add up to about ${stopsMin} minutes.`;
  return null;
}

export function deadPhoneLine({ lastAt, place, battery, kmLeft }) {
  const where = place ? ` near ${place}` : "";
  const left = kmLeft == null ? "" : `, ${Math.round(kmLeft)} km from the destination`;
  const power = battery == null ? " The phone may be off or out of signal." : battery <= 15 ? ` The battery was ${battery}%, so the phone may have switched off.` : ` The battery was ${battery}%. It may be out of signal.`;
  return `No update since ${clock(lastAt)}. Last seen${where}${left}.${power} Not an emergency on its own.`;
}

export function catchUpLine(back, at, place) {
  if (!back || typeof back.from !== "number" || at == null) return null;
  const minutes = Math.round((at - back.from) / 60000);
  const head = `Back online ${clock(at)}.`;
  if (typeof back.n === "number" && back.n <= 0) return `${head} No location was recorded during the ${minutes} minutes without signal.`;
  if (typeof back.km === "number" && back.km >= 1) return `${head} Kept moving, ${Math.round(back.km)} km covered while out of signal.`;
  return `${head} Stayed${place ? ` near ${place}` : ""} during the ${minutes} minutes without signal.`;
}

/** {title, tone, sentence, lastUpdate, kmLeft} for what the family should read. */
export function viewState({ trip, spot, dead, now = Date.now(), closedTrip = false }) {
  const name = trip ? trip.name : "The driver";
  const to = trip ? trip.to : "the destination";
  if (!spot || typeof spot.km !== "number") {
    if (closedTrip || (spot && spot.revoked)) return { title: "Tracking stopped", tone: "quiet", sentence: spot && spot.arrived ? `${name} confirmed arrival. You don't have to call.` : "The journey has ended. The code is closed.", lastUpdate: null, kmLeft: null };
    return { title: "Waiting for a location", tone: "quiet", sentence: "Waiting for the first point. The clock is not moving the car.", lastUpdate: null, kmLeft: trip ? trip.totalKm : null };
  }
  const at = typeof spot.updatedAt === "number" ? spot.updatedAt : null;
  const total = trip ? trip.totalKm : spot.km;
  const kmLeft = Math.max(0, total - spot.km);
  const place = typeof spot.place === "string" ? spot.place : null;
  const out = (title, tone, sentence) => ({ title, tone, sentence, lastUpdate: at, kmLeft });
  if (spot.revoked || spot.interrupt === "closed") {
    return spot.arrived ? out("Arrived safely", "calm", `${name} confirmed arrival. You don't have to call.`) : out("Tracking stopped", "quiet", "The driver ended the journey before arrival. The code is closed.");
  }
  if (spot.checkin === "help" || (spot.sos === true && spot.checkin !== "safe")) return out("Needs help", "help", place ? `${name} asked for help at ${place}. This is the moment to act.` : `${name} asked for help. This is the moment to act.`);
  if (spot.paused) return out("Sharing paused", "quiet", `${name} paused sharing. That is not a signal gap.`);
  const stale = at != null && now - at >= staleAfter(Number(spot.every) || 0);
  if (stale) {
    const deadSays = dead && typeof dead.lastAt === "number" && dead.lastAt + 1000 >= at;
    if (now - at >= 20 * 60000 || deadSays) return out("Signal gap", "quiet", deadPhoneLine({ lastAt: at, place, battery: typeof spot.battery === "number" ? Math.round(spot.battery) : null, kmLeft }));
    return out("Signal gap", "quiet", place ? `Updates have stopped. Last point ${place}, ${clock(at)}. Not an emergency.` : `Updates have stopped. Last point ${clock(at)}. Not an emergency.`);
  }
  const back = catchUpLine(spot.back, at, place);
  const lead = back ? back + " " : "";
  if (kmLeft <= 3 && kmLeft > 0) return out("Near the destination", "calm", `${lead}Near ${to}. Not arrived yet. The code stays open.`);
  const stillMin = typeof spot.movedAt === "number" ? Math.max(0, Math.floor((now - spot.movedAt) / 60000)) : 0;
  const stopMin = [15, 30, 45].includes(spot.stopMin) ? spot.stopMin : 15;
  const said = typeof spot.checkin === "string" && spot.checkin !== "help" ? spot.checkin : null;
  if (stillMin >= stopMin && !said) return out("Check-in requested", "checkin", `${lead}${place ? `Stopped longer than expected at ${place}.` : "Stopped longer than expected."} Waiting for the next update.`);
  const speed = trip ? trip.speedKmh : 60;
  const moveMin = typeof spot.roadMin === "number" ? spot.roadMin : (kmLeft / speed) * 60;
  const arrivesAt = trip && trip.start ? trip.start + (total / speed) * 3600000 : null;
  const late = arrivesAt ? Math.round((now + moveMin * 60000 - arrivesAt) / 60000) : 0;
  const minutes = moveMin >= 1 ? Math.round(moveMin) : null;
  if (late > 8) {
    const why = delayReason({ stillMin, stopsMin: Number(spot.stopsMin) || 0, paceKmh: typeof spot.paceKmh === "number" ? Math.round(spot.paceKmh) : null, plannedKmh: speed, driverSaid: said }) || (said ? `${CHECKIN[said] || said}.` : "No reason is known yet.");
    if (late > 25) return out("At risk", "checkin", `${lead}This needs a look. About ${late} minutes past the plan. ${why} Last point ${place || clock(at)}.`);
    return out("Delayed", "calm", `${lead}Running about ${late} minutes late. ${why}${minutes ? ` About ${minutes} minutes remaining.` : ""} Not an emergency.`);
  }
  if (said) return out("On track", "calm", `${lead}${CHECKIN[said] || said}. Not an emergency.`);
  return out("On track", "calm", `${lead}${minutes ? `On schedule. About ${minutes} minutes remaining.` : "On schedule. No action is needed."}`);
}

// ---- Page ------------------------------------------------------------------

export async function load(code, fetcher = globalThis.fetch, now = Date.now()) {
  const [tripBody, spot, dead] = await Promise.all([latest(code, "trip", "12h", fetcher), latest(code, "spot", "3h", fetcher), latest(code, "dead", "3h", fetcher).catch(() => null)]);
  const trip = readTrip(tripBody);
  if (!trip && !spot) return null;
  return viewState({ trip, spot, dead, now, closedTrip: Boolean(tripBody && tripBody.revoked) });
}
