// Hushmile group headcount (app 1.1.0, API 1.5.14). One script for both
// links the travel desk makes for a group booking:
//   tour.html#TOUR.KEY   the guide: add names, start a halt "leaves in N min",
//                        see who is not back and remind them on WhatsApp
//   board.html#TOUR.KEY  the passengers: tap your own name, "I'm back on the bus"
// The key is after #, so it never reaches the web host, and it is sent to
// api.hushmile.com in a POST body, never in a URL. No accounts, no photos.
// The server decides which link is which (the answer's "role").

import { LANGUAGE_INFO } from "./i18n.js";
import { clock, language, LANGUAGES, pickLanguage, setLanguage, t } from "./hushmile-viewer.js";

export const TOUR_API = "https://api.hushmile.com/v1/tour";
/** How often an open page reads the list (the server allows this for a full bus behind one address). */
export const TOUR_POLL_MS = 20000;
export const TOUR_MAX_NAMES = 80;
export const TOUR_NAME_MAX = 40;
export const HALT_DEFAULT_MIN = 20;
export const HALT_MAX_MIN = 240;
export const EXTEND_MIN = 10;

const HEX32 = /^[0-9a-f]{32}$/;

/** "#tour.key" -> {tour, key}; null when the link is not a tour link. */
export function parseTourHash(hash) {
  const raw = String(hash || "").replace(/^#/, "").trim().toLowerCase();
  const [tour, key, ...rest] = raw.split(".");
  if (rest.length || !HEX32.test(tour || "") || !HEX32.test(key || "")) return null;
  return { tour, key };
}

/** The guide's "add names" box: one person per line, "Name, phone" for a
 * reminder number. Blank lines and repeats (same name and phone) are dropped. */
export function splitNames(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const at = line.lastIndexOf(",");
    const maybePhone = at >= 0 ? line.slice(at + 1).trim() : "";
    const isPhone = /^\+?[0-9 ()./-]{6,20}$/.test(maybePhone) && /[0-9]{6}/.test(maybePhone.replace(/[^0-9]/g, ""));
    const name = (isPhone ? line.slice(0, at) : line).replace(/\s+/g, " ").trim().slice(0, TOUR_NAME_MAX);
    if (!name) continue;
    const phone = isPhone ? maybePhone : "";
    const id = `${name.toLowerCase()}|${phone.replace(/[^0-9]/g, "")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name, phone });
  }
  return out;
}

/** Where the current halt stands. "now" is the server's clock when it gave
 * one, so a phone with a wrong clock still counts down right. */
export function haltState(view, now) {
  const h = view && view.halt;
  if (!h || typeof h.at !== "number") return { kind: "none" };
  if (typeof h.endedAt === "number") return { kind: "ended", endedAt: h.endedAt, place: h.place || "" };
  if (typeof h.leavesAt !== "number") return { kind: "none" };
  const left = h.leavesAt - now;
  if (left >= 0) return { kind: "open", leavesAt: h.leavesAt, minLeft: Math.ceil(left / 60000), place: h.place || "" };
  return { kind: "late", leavesAt: h.leavesAt, lateMin: Math.max(1, Math.floor(-left / 60000)), place: h.place || "" };
}

/** Not back first (in the guide's order), then back. */
export function missingFirst(pax) {
  const list = Array.isArray(pax) ? pax : [];
  return [...list.filter((p) => !p.back), ...list.filter((p) => p.back)];
}

/** Same digits rule as the app (lib/voice/listen.dart waDigits). */
export function waDigits(phone, countryCode = "91") {
  let d = String(phone || "").replace(/[^0-9]/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = countryCode + d;
  return d;
}

/** WhatsApp with the reminder typed in; null without a usable number. */
export function nudgeLink(person, leavesAt) {
  const digits = waDigits(person && person.phone);
  if (digits.length < 10 || digits.length > 15) return null;
  const text = t.webTourNudgeText({ name: person.name, time: clock(leavesAt) });
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Plain words for an error answer. */
export function errorWords(status, code) {
  if (status === 401) return t.webTourBadLink();
  if (status === 409 && code === "bad_state") return t.webTourClosed();
  if (status === 429 && code === "tour_full") return t.webTourFull();
  if (status === 429) return t.webTourBusy();
  if (status === 0) return t.webTourOffline();
  return t.webTourOffline();
}

/** One POST to the tour API; {ok, status, body}. status 0 = no connection. */
export async function tourPost(path, body, fetcher = globalThis.fetch) {
  try {
    const res = await fetcher(`${TOUR_API}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), referrerPolicy: "no-referrer", cache: "no-store" });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, body: json };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

// ---- Page ------------------------------------------------------------------

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
}

function readSaved() {
  try {
    return localStorage.getItem("hushmile-lang");
  } catch {
    return null;
  }
}

function startPage() {
  const $ = (id) => document.getElementById(id);
  const link = parseTourHash(location.hash);
  let view = null;
  let skew = 0;
  let note = "";
  let busy = false;
  let timer = null;
  let minutes = HALT_DEFAULT_MIN;

  const now = () => Date.now() + skew;

  async function call(path, extra = {}) {
    if (!link) return;
    busy = true;
    const res = await tourPost(path, { tour: link.tour, key: link.key, ...extra });
    busy = false;
    if (res.ok && res.body) {
      view = res.body;
      if (typeof view.now === "number") skew = view.now - Date.now();
      note = view.open === false ? t.webTourClosed() : "";
    } else {
      note = errorWords(res.status, res.body && res.body.error);
      if (res.status === 401) view = null;
    }
    paint();
  }

  function paintStatic() {
    document.documentElement.lang = language();
    document.title = `Hushmile · ${t.webTourTitle()}`;
    $("title").textContent = t.webTourTitle();
    $("lang-label").textContent = t.language();
    $("privacy").textContent = t.privacy();
    const select = $("lang");
    select.replaceChildren(...["system", ...LANGUAGES].map((code) => el("option", { value: code, textContent: code === "system" ? t.languageSystem() : LANGUAGE_INFO[code].label })));
    select.value = readSaved() || "system";
  }

  function haltCard(guide) {
    const h = haltState(view, now());
    const box = el("section", { className: "card" });
    if (h.kind === "open" || h.kind === "late") {
      box.append(el("div", { className: "big", textContent: t.webTourLeavesAt({ time: clock(h.leavesAt) }) }));
      box.append(el("div", { className: h.kind === "late" ? "warn" : "sub", textContent: h.kind === "late" ? t.webTourLate({ n: h.lateMin }) : t.webTourLeavesIn({ n: h.minLeft }) }));
      if (h.place) box.append(el("div", { className: "sub", textContent: h.place }));
      box.append(el("div", { className: "count", textContent: t.webTourCount({ back: view.back || 0, total: view.total || 0 }) }));
    } else {
      box.append(el("div", { className: "sub", textContent: h.kind === "ended" ? t.webTourEnded() : t.webTourNoHalt() }));
    }
    if (guide && view.open !== false) {
      const row = el("div", { className: "row" });
      if (h.kind === "open" || h.kind === "late") {
        row.append(el("button", { type: "button", textContent: t.webTourExtend(), onclick: () => call("halt", { action: "extend", minutes: EXTEND_MIN }) }));
        row.append(el("button", { type: "button", className: "ghost", textContent: t.webTourEnd(), onclick: () => call("halt", { action: "end" }) }));
      } else {
        const mins = el("input", { type: "number", min: "1", max: String(HALT_MAX_MIN), value: String(minutes), inputMode: "numeric", id: "halt-min" });
        mins.addEventListener("input", () => { minutes = Number(mins.value) || HALT_DEFAULT_MIN; });
        const place = el("input", { type: "text", maxLength: 60, id: "halt-place", placeholder: t.webTourPlace() });
        row.append(el("label", { className: "field" }, el("span", { textContent: t.webTourMinutes() }), mins));
        row.append(el("label", { className: "field" }, el("span", { textContent: t.webTourPlace() }), place));
        row.append(el("button", { type: "button", textContent: t.webTourStart(), onclick: () => {
          const n = Math.round(Number(mins.value));
          if (!(n >= 1 && n <= HALT_MAX_MIN)) return mins.focus();
          call("halt", { action: "start", minutes: n, place: place.value.trim() });
        } }));
      }
      box.append(row);
    }
    return box;
  }

  function personRow(p, guide, halt) {
    const row = el("li", { className: p.back ? "person back" : "person" });
    row.append(el("span", { className: "name", textContent: p.name }));
    if (p.back) {
      row.append(el("span", { className: "ok", textContent: `✓ ${t.webTourIsBack()}` }));
      row.append(el("button", { type: "button", className: "link", textContent: t.webTourUndo(), onclick: () => call("back", { pax: p.id, back: false }) }));
    } else if (halt) {
      row.append(el("button", { type: "button", textContent: guide ? t.webTourMark() : t.webTourBack(), onclick: () => call("back", { pax: p.id, back: true }) }));
      if (guide) {
        const wa = nudgeLink(p, view.halt.leavesAt);
        row.append(wa ? el("a", { className: "btn ghost", href: wa, target: "_blank", rel: "noopener noreferrer", textContent: t.webTourNudge() }) : el("span", { className: "sub", textContent: t.webTourNoPhone() }));
      }
    }
    if (guide && view.open !== false) {
      row.append(el("button", { type: "button", className: "link", textContent: t.webTourRemove(), onclick: () => { if (confirm(`${t.webTourRemove()}: ${p.name}?`)) call("pax", { remove: [p.id] }); } }));
    }
    return row;
  }

  function paint() {
    const body = $("body");
    body.replaceChildren();
    if (!link || !view) {
      body.append(el("p", { className: "card warn", textContent: note || (link ? t.webTourOffline() : t.webTourBadLink()) }));
      return;
    }
    const guide = view.role === "guide";
    const trip = [view.company, view.vehicle].filter(Boolean).join(" · ");
    const route = [view.from, view.to].filter(Boolean).join(" → ");
    body.append(el("p", { className: "sub", textContent: [trip, route].filter(Boolean).join(" — ") }));
    if (note) body.append(el("p", { className: "card warn", textContent: note }));
    body.append(haltCard(guide));
    const h = haltState(view, now());
    const halting = h.kind === "open" || h.kind === "late";
    const people = guide ? missingFirst(view.pax) : view.pax || [];
    if (!people.length) body.append(el("p", { className: "sub", textContent: t.webTourEmpty() }));
    else {
      if (!guide && halting) body.append(el("h2", { textContent: t.webTourPick() }));
      if (guide && halting) {
        const missing = people.filter((p) => !p.back).length;
        body.append(el("h2", { textContent: missing ? `${t.webTourMissing()} (${missing})` : t.webTourAllBack() }));
      }
      body.append(el("ul", { className: "people" }, ...people.map((p) => personRow(p, guide, halting && view.open !== false))));
    }
    if (halting) body.append(el("p", { className: "note", textContent: t.webTourCountHeads() }));
    if (guide && view.open !== false) {
      const box = el("textarea", { id: "names", rows: 4, placeholder: t.webTourAddHint() });
      body.append(el("section", { className: "card" },
        el("h2", { textContent: t.webTourAddNames() }),
        el("p", { className: "sub", textContent: t.webTourAddHint() }),
        box,
        el("button", { type: "button", textContent: t.webTourAdd(), onclick: async () => {
          const add = splitNames(box.value);
          if (!add.length) return;
          await call("pax", { add });
          if (!note) box.value = "";
        } })));
      body.append(el("p", { className: "note", textContent: t.webTourGuideOnly() }));
    }
    if (view.now) body.append(el("p", { className: "note", textContent: t.webTourUpdated({ time: clock(now()) }) }));
  }

  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState !== "visible" || !link) return;
    timer = setTimeout(async () => {
      if (!busy && !document.querySelector("textarea:focus, input:focus")) await call("read");
      schedule();
    }, TOUR_POLL_MS);
  }

  $("lang").addEventListener("change", () => {
    const choice = $("lang").value;
    try {
      if (choice === "system") localStorage.removeItem("hushmile-lang");
      else localStorage.setItem("hushmile-lang", choice);
    } catch {}
    setLanguage(pickLanguage(choice === "system" ? null : choice, navigator.languages || [navigator.language]));
    paintStatic();
    paint();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") call("read").then(schedule);
    else clearTimeout(timer);
  });
  window.addEventListener("hashchange", () => location.reload());

  setLanguage(pickLanguage(readSaved(), navigator.languages || [navigator.language]));
  paintStatic();
  paint();
  if (link) call("read").then(schedule);
}

if (typeof document !== "undefined" && document.getElementById("tour-page")) startPage();
