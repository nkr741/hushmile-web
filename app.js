import { bareCode, clock, language, LANGUAGES, load, pickLanguage, setLanguage, shownCode, t } from "./hushmile-viewer.js";

const bands = { calm: "toneCalm", checkin: "toneCheckin", help: "toneHelp", quiet: "toneQuiet" };
const NAMES = { en: "English", te: "తెలుగు", hi: "हिन्दी" };
const $ = (id) => document.getElementById(id);
let timer = null;
let current = null;
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
  $("battery").textContent = state.battery != null ? (state.charging ? t.batteryCharging({ n: state.battery }) : t.batteryPct({ n: state.battery })) : "";
}

async function refresh(code) {
  try {
    const state = await load(code);
    if (!state) {
      show({ tone: "quiet", sentence: t.codeNotOpen(), lastUpdate: null, kmLeft: null, battery: null });
      return;
    }
    show(state);
  } catch {
    show({ tone: "quiet", sentence: t.webRelayFail(), lastUpdate: null, kmLeft: null, battery: null });
  }
}

function start(code) {
  if (bareCode(code).length !== 8) return;
  const shown = shownCode(code);
  current = shown;
  $("code").value = shown;
  if (location.hash.slice(1) !== shown) history.replaceState(null, "", `#${shown}`);
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
start(decodeURIComponent(location.hash.slice(1)));
