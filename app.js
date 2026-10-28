import { bareCode, clock, language, LANGUAGES, linkKeyText, load, mapAgeLine, pickLanguage, readInput, setLanguage, t } from "./hushmile-viewer.js";
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

// ---- Map (Leaflet + OpenStreetMap tiles, both loaded from this site / OSM) --
// Blue line: the planned route. Grey dots: earlier places (the trail the
// phone sent). The marker: the last known place, with how long ago.
let map = null;
let layers = null;
let fitted = false;

function drawMap(data) {
  const box = $("map-box");
  const L = globalThis.L;
  if (!data || !L) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  if (!map) {
    map = L.map("map", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      // OSM's tile policy asks for a Referer; send only the site, never a path.
      referrerPolicy: "strict-origin",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    layers = L.layerGroup().addTo(map);
  }
  layers.clearLayers();
  const bounds = [];
  if (data.route.length > 1) {
    L.polyline(data.route, { color: "#2d69fc", weight: 4, opacity: 0.55 }).addTo(layers);
    bounds.push(...data.route);
  }
  for (const [lat, lng] of data.trail) {
    L.circleMarker([lat, lng], { radius: 4, color: "#5f6673", fillColor: "#5f6673", fillOpacity: 0.8, weight: 1 }).addTo(layers);
  }
  if (data.last) {
    const stale = data.last.at != null && Date.now() - data.last.at > 15 * 60000;
    L.circleMarker([data.last.lat, data.last.lng], { radius: 9, color: "#fff", weight: 3, fillColor: stale ? "#5f6673" : "#2d69fc", fillOpacity: 1 })
      .bindTooltip(mapAgeLine(data.last.at), { permanent: true, direction: "top", offset: [0, -10] })
      .addTo(layers);
    bounds.push([data.last.lat, data.last.lng]);
  }
  $("map-note").textContent = [data.route.length > 1 ? t.mapPlanned() : "", data.trail.length ? t.mapTrail() : ""].filter(Boolean).join(" ");
  if (!fitted && bounds.length) {
    // Fit once; after that keep the family's own zoom and pan.
    if (bounds.length === 1) map.setView(bounds[0], 13);
    else map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
    fitted = true;
  }
  map.invalidateSize();
}

async function refresh(code) {
  try {
    // With the key from the link; a code-only link asks the server for it.
    const state = await load(code, globalThis.fetch, Date.now(), currentKey || undefined);
    if (!state) {
      show({ tone: "quiet", sentence: t.codeNotOpen(), lastUpdate: null, kmLeft: null, battery: null });
      return;
    }
    show(state);
  } catch {
    show({ tone: "quiet", sentence: t.webRelayFail(), lastUpdate: null, kmLeft: null, battery: null });
  }
}

function start(input) {
  const { code: shown, key } = readInput(input);
  if (bareCode(shown).length !== 8) return;
  if (shown !== current) {
    fitted = false;
    if (layers) layers.clearLayers();
  }
  current = shown;
  currentKey = key;
  $("code").value = shown;
  // Keep the link key in the address (old links have none; both work).
  const hash = key ? `${shown}.${linkKeyText(key)}` : shown;
  if (location.hash.slice(1) !== hash) history.replaceState(null, "", `#${hash}`);
  $("sentence").textContent = t.openingJourney();
  clearInterval(timer);
  refresh(shown);
  timer = setInterval(() => refresh(shown), 60000);
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
  if (current) refresh(current);
  else if (!shownState) $("sentence").textContent = t.webEnter();
});

setLanguage(pickLanguage(readSaved(), navigator.languages || [navigator.language]));
paintPage();
$("band").textContent = t.webJourney();
$("sentence").textContent = t.webEnter();
start(location.hash.slice(1));
addEventListener("hashchange", () => start(location.hash.slice(1)));
