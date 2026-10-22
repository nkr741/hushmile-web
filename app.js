import { bareCode, clock, load, shownCode } from "./hushmile-viewer.js";

const labels = { calm: "All okay", checkin: "Check-in needed", help: "Needs help", quiet: "No new update" };
const $ = (id) => document.getElementById(id);
let timer = null;

function show(state) {
  $("status").style.setProperty("--tone", `var(--${state.tone})`);
  $("band").textContent = labels[state.tone] || "Journey";
  $("sentence").textContent = state.sentence;
  $("last").textContent = state.lastUpdate ? `Last update ${clock(state.lastUpdate)} · ${Math.floor((Date.now() - state.lastUpdate) / 60000)} min ago` : "Last update not yet received";
  $("left").textContent = state.kmLeft != null ? `${Math.round(state.kmLeft)} km left` : "";
}

async function refresh(code) {
  try {
    const state = await load(code);
    if (!state) {
      show({ tone: "quiet", sentence: "That Journey Code is not open. Ask them to send it again.", lastUpdate: null, kmLeft: null });
      return;
    }
    show(state);
  } catch {
    show({ tone: "quiet", sentence: "The relay did not answer. This page tries again in a minute. That is not news about the journey.", lastUpdate: null, kmLeft: null });
  }
}

function start(code) {
  if (bareCode(code).length !== 8) return;
  const shown = shownCode(code);
  $("code").value = shown;
  if (location.hash.slice(1) !== shown) history.replaceState(null, "", `#${shown}`);
  $("sentence").textContent = "Opening the journey…";
  clearInterval(timer);
  refresh(shown);
  timer = setInterval(() => refresh(shown), 60000);
}

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  start($("code").value);
});
start(decodeURIComponent(location.hash.slice(1)));
