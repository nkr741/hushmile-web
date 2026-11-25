import { createMap } from "./map-view.js";
import { mapConfig } from "./map-config.js";
import { bareCode, clock, DROP_EVERY_MS, dropCard, dropDone, language, LANGUAGES, linkKeyText, load, mapAgeLine, pickLanguage, readDrop, readInput, setLanguage, t, oneAtATime, WAKE_DELAY_MS, wakeTopics, wakeUrl } from "./hushmile-viewer.js";
import { LANGUAGE_INFO } from "./i18n.js";

const bands = { calm: "toneCalm", checkin: "toneCheckin", help: "toneHelp", quiet: "toneQuiet" };
const NAMES = Object.fromEntries(LANGUAGES.map((code) => [code, LANGUAGE_INFO[code].label]));
const $ = (id) => document.getElementById(id);
let timer = null;
let current = null;
let currentKey = null;
let shownState = null;

function readSaved() {
  try {
    return localStorage.getItem("hushmile-lang");
  } catch {
    return null;
  }
}

/** Static words on the page, in the chosen language. */
function paintPage() {
  document.documentElement.lang = language();
  document.title = t.webTitle();
  $("code-label").textContent = t.journeyCode();
  $("open").textContent = t.webOpen();
  $("note-text").textContent = `${t.webNote()} `;
  $("privacy").textContent = t.privacy();
  $("lang-label").textContent = t.language();
  $("legend-planned-text").textContent = t.mapLegendPlanned();
  $("legend-driven-text").textContent = t.mapLegendDriven();
  labelMap();
  const select = $("lang");
  select.replaceChildren();
  for (const code of ["system", ...LANGUAGES]) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = code === "system" ? t.languageSystem() : NAMES[code];
    select.append(option);
  }
  select.value = readSaved() || "system";
}

// The map and its buttons, in the page's language, for screen readers
// (MapLibre and Leaflet name their zoom buttons in English).
function labelMap() {
  $("map").setAttribute("aria-label", t.mapLabel());
  const name = (selector, text) => {
    for (const el of $("map").querySelectorAll(selector)) {
      el.setAttribute("aria-label", text);
      el.title = text;
    }
  };
  name(".hm-fit", t.mapShowRoute());
  name(".maplibregl-ctrl-zoom-in, .leaflet-control-zoom-in", t.mapZoomIn());
  name(".maplibregl-ctrl-zoom-out, .leaflet-control-zoom-out", t.mapZoomOut());
}

function show(state) {
  shownState = state;
  $("status").style.setProperty("--tone", `var(--${state.tone})`);
  $("band").textContent = bands[state.tone] ? t[bands[state.tone]]() : t.webJourney();
  $("sentence").textContent = state.sentence;
  $("last").textContent = t.lastUpdate({ at: state.lastUpdate ? `${clock(state.lastUpdate)} · ${t.minAgo({ n: Math.floor((Date.now() - state.lastUpdate) / 60000) })}` : t.notYetReceived() });
  $("left").textContent = state.kmLeft != null ? t.kmLeft({ km: state.kmLeft < 10 ? state.kmLeft.toFixed(1) : String(Math.round(state.kmLeft)) }) : "";
  $("speed").textContent = state.speed || "";
  const roads = $("roads");
  roads.replaceChildren(...(state.roads || []).map((line) => Object.assign(document.createElement("div"), { textContent: line })));
  roads.hidden = !(state.roads || []).length;
  $("not-from-phone").textContent = state.notFromPhone || "";
  $("not-from-phone").hidden = !state.notFromPhone;
  paintSos(state.sos || null);
  paintHelp(state.help || null);
  $("battery").textContent = state.battery != null ? (state.charging ? t.batteryCharging({ n: state.battery }) : t.batteryPct({ n: state.battery })) : "";
  drawMap(state.map || null);
}

const link = ({ label, href }) => Object.assign(document.createElement("a"), { textContent: label, href, rel: "noopener" });

/** The SOS banner, until the traveller taps "I'm safe now". */
function paintSos(sos) {
  $("sos").hidden = !sos;
  if (!sos) return;
  $("sos-title").textContent = sos.title;
  $("sos-body").textContent = sos.body;
  $("sos-sub").textContent = sos.noPhone ? `${sos.sub} ${sos.noPhone}` : sos.sub;
  $("sos-links").replaceChildren(...[sos.call, sos.map].filter(Boolean).map(link));
}

/** Help on the route: dial links (the phone's dialler opens; nothing is
 * called by itself) and map searches near the last position. */
function paintHelp(help) {
  $("help").hidden = !help;
  if (!help) return;
  $("help-title").textContent = t.helpOnRoute();
  $("help-links").replaceChildren(...help.dial.map(link));
  $("help-search").replaceChildren(...help.search.map(link));
  $("help-note").textContent = t.dialNote();
}

// ---- Map (map-view.js: MapLibre + OpenFreeMap; Leaflet + OSM without WebGL)
// Blue line: the planned route. Green: the road taken so far (the trail the
// phone sent), with dots. The marker: the last known place, its heading and
// how sure the phone was (the halo).
let mapView = null;
let mapStarting = null;

/** The older raster map, kept for browsers without WebGL. */
function leafletMap(el) {
  const L = globalThis.L;
  if (!L) return null;
  const map = L.map(el, { zoomControl: true, attributionControl: true });
  L.tileLayer(mapConfig.rasterTiles, {
    maxZoom: 19,
    // OSM's tile policy asks for a Referer; send only the site, never a path.
    referrerPolicy: "strict-origin",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  const layers = L.layerGroup().addTo(map);
  let fitted = false;
  let bounds = [];
  const fit = () => {
    if (bounds.length === 1) map.setView(bounds[0], 13);
    else if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
  };
  const c = mapConfig.colors;
  return {
    engine: "leaflet",
    fit,
    reset: () => (fitted = false),
    draw(data, label) {
      layers.clearLayers();
      bounds = [];
      if (data.route.length > 1) {
        L.polyline(data.route, { color: "#fff", weight: 8, opacity: 0.9 }).addTo(layers);
        L.polyline(data.route, { color: c.route, weight: 5, opacity: 0.8 }).addTo(layers);
        bounds.push(...data.route);
      }
      const driven = [...data.trail.map(([lat, lng]) => [lat, lng]), ...(data.last ? [[data.last.lat, data.last.lng]] : [])];
      if (driven.length > 1) L.polyline(driven, { color: c.driven, weight: 4, opacity: 0.95 }).addTo(layers);
      for (const [lat, lng] of data.trail) {
        L.circleMarker([lat, lng], { radius: 4, color: "#fff", fillColor: c.driven, fillOpacity: 0.85, weight: 1.5 }).addTo(layers);
      }
      if (data.last) {
        const stale = data.last.at != null && Date.now() - data.last.at > 15 * 60000;
        if (data.last.acc) L.circle([data.last.lat, data.last.lng], { radius: data.last.acc, color: stale ? c.stale : c.driven, weight: 1, fillOpacity: 0.14 }).addTo(layers);
        const mark = Array.isArray(data.last.mark) ? data.last.mark : [data.last.lat, data.last.lng];
        L.circleMarker(mark, { radius: 9, color: "#fff", weight: 3, fillColor: stale ? c.stale : c.driven, fillOpacity: 1 })
          .bindTooltip(label, { permanent: true, direction: "top", offset: [0, -10] })
          .addTo(layers);
        bounds.push([data.last.lat, data.last.lng]);
      }
      if (!fitted && bounds.length) {
        // Fit once; after that keep the family's own zoom and pan.
        fit();
        fitted = true;
      }
      map.invalidateSize();
    },
  };
}

async function drawMap(data) {
  const box = $("map-box");
  if (!data) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (!mapView) {
    mapStarting ??= createMap($("map"), { leaflet: leafletMap });
    mapView = await mapStarting;
    if (!mapView) {
      box.hidden = true;
      return;
    }
    labelMap();
  }
  const label = data.last ? mapAgeLine(data.last.at) : "";
  mapView.draw(data, label);
  $("legend-planned").hidden = data.route.length < 2;
  $("legend-driven").hidden = data.trail.length === 0;
  $("map-note").textContent = label;
}

// One read at a time: a push and the minute's poll can land together. A
// read asked for while one runs is done once, right after it (it may hold
// a newer update), for the journey asked for last.
const refresh = oneAtATime((code) => readOnce(code));

async function readOnce(code) {
  try {
    // With the key from the link; a code-only link asks the server for it.
    const state = await load(code, globalThis.fetch, Date.now(), currentKey || undefined);
    if (!state) {
      show({ tone: "quiet", sentence: t.codeNotOpen(), lastUpdate: null, kmLeft: null, battery: null });
      return;
    }
    show(state);
    listen(code, state.linkKey);
  } catch {
    show({ tone: "quiet", sentence: t.webRelayFail(), lastUpdate: null, kmLeft: null, battery: null });
  }
}

// The travel desk passenger's drop-off code (app 1.1.1): read with the key
// from the link every few minutes until the driver has checked it.
let dropKey = null;
let dropTimer = null;
let lastDrop = null;
function paintDrop() {
  const card = dropCard(lastDrop);
  $("drop").hidden = !card;
  if (!card) return;
  $("drop-title").textContent = card.title;
  $("drop-code").textContent = card.code;
  $("drop-code").hidden = !card.code;
  $("drop-body").textContent = card.body;
}
async function refreshDrop() {
  if (!dropKey) return;
  const got = await readDrop(dropKey);
  if (got) lastDrop = got;
  paintDrop();
  if (dropDone(lastDrop)) clearInterval(dropTimer);
}
function startDrop(key) {
  clearInterval(dropTimer);
  dropKey = key || null;
  lastDrop = null;
  paintDrop();
  if (!dropKey) return;
  refreshDrop();
  dropTimer = setInterval(() => {
    if (!document.hidden) refreshDrop();
  }, DROP_EVERY_MS);
}

// The passenger's drop-off page (#d<key>, from the drop_code WhatsApp
// message): only the code card, no journey to open or poll.
function startDropOnly(drop) {
  clearInterval(timer);
  for (const s of streams) s.close();
  streams = [];
  streamFor = "";
  current = null;
  currentKey = null;
  if (drop !== dropKey) startDrop(drop);
  if (location.hash.slice(1) !== `d${drop}`) history.replaceState(null, "", `#d${drop}`);
  $("sentence").textContent = t.webDropOnly();
}

function start(input) {
  const { code: shown, key, drop } = readInput(input);
  if (!shown && drop) return startDropOnly(drop);
  if (bareCode(shown).length !== 8) return;
  if (shown !== current) {
    mapView?.reset();
  }
  current = shown;
  currentKey = key;
  $("code").value = shown;
  if (drop !== dropKey) startDrop(drop);
  // Keep the link key (and a drop-off code key) in the address.
  const hash = (key ? `${shown}.${linkKeyText(key)}` : shown) + (drop ? `.d${drop}` : "");
  if (location.hash.slice(1) !== hash) history.replaceState(null, "", `#${hash}`);
  $("sentence").textContent = t.openingJourney();
  clearInterval(timer);
  refresh(shown);
  // A hidden tab skips the poll; it reads at once when shown again.
  timer = setInterval(() => {
    if (!document.hidden) refresh(shown);
  }, 60000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current) refresh(current);
});

// A push from the relay (server-sent events) as soon as the phone posts:
// the page reads the new update at once instead of waiting for the next
// minute's poll. The push only says "something new"; the update itself is
// still read, checked and decrypted by refresh(). Polling stays as the
// fallback when the stream is not available (older browser, blocked network).
let streams = [];
let streamFor = "";
let wakeTimer = null;
async function listen(code, key) {
  if (typeof EventSource !== "function") return;
  const topics = await wakeTopics(code, key).catch(() => []);
  const sig = `${code}|${topics.join(",")}`;
  if (current !== code || sig === streamFor) return;
  for (const s of streams) s.close();
  streams = [];
  streamFor = sig;
  for (const topic of topics) {
    try {
      const s = new EventSource(wakeUrl(topic));
      s.addEventListener("message", () => {
        clearTimeout(wakeTimer);
        wakeTimer = setTimeout(() => {
          if (current === code && !document.hidden) refresh(code);
        }, WAKE_DELAY_MS);
      });
      // On error the browser retries by itself; the minute's poll covers the gap.
      streams.push(s);
    } catch {
      // No stream: polling only.
    }
  }
}

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  start($("code").value);
});
$("lang").addEventListener("change", () => {
  const choice = $("lang").value;
  try {
    if (choice === "system") localStorage.removeItem("hushmile-lang");
    else localStorage.setItem("hushmile-lang", choice);
  } catch {}
  setLanguage(pickLanguage(choice === "system" ? null : choice, navigator.languages || [navigator.language]));
  paintPage();
  paintDrop();
  if (current) refresh(current);
  else if (dropKey && location.hash.slice(1) === `d${dropKey}`) $("sentence").textContent = t.webDropOnly();
  else if (!shownState) $("sentence").textContent = t.webEnter();
});

setLanguage(pickLanguage(readSaved(), navigator.languages || [navigator.language]));
paintPage();
$("band").textContent = t.webJourney();
$("sentence").textContent = t.webEnter();
start(location.hash.slice(1));
addEventListener("hashchange", () => start(location.hash.slice(1)));
