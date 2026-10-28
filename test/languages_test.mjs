// Every app language reaches the web viewer, the driver page and the privacy page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { LANGUAGE_INFO, STRINGS } from "../i18n.js";
import { clock, dayAndClock, endSentence, LANGUAGES, pickLanguage, setLanguage, t } from "../hushmile-viewer.js";

const here = new URL("..", import.meta.url);
const read = (name) => readFileSync(new URL(name, here), "utf8");
// The app repo keeps a copy of the viewer without the site pages.
const site = { skip: !existsSync(new URL("privacy.html", here)) };
const holes = (s) => [...s.matchAll(/\$\{a\.(\w+)/g)].map((m) => m[1]).sort().join(",");

test("the language list comes from the app's table and includes Tamil and Kannada", () => {
  assert.deepEqual(LANGUAGES, ["en", "te", "hi", "ta", "kn"]);
  assert.equal(LANGUAGE_INFO.ta.label, "தமிழ்");
  assert.equal(LANGUAGE_INFO.kn.label, "ಕನ್ನಡ");
  assert.equal(pickLanguage(null, ["ta-IN", "en"]), "ta");
  assert.equal(pickLanguage(null, ["kn"]), "kn");
  assert.equal(pickLanguage("kn", ["te"]), "kn", "a saved choice wins");
  assert.equal(pickLanguage(null, ["ml-IN", "fr"]), "en", "unknown languages fall back to English");
  assert.equal(setLanguage("ml"), "en");
});

test("Tamil and Kannada have every web string with the same placeholders, in their own script", () => {
  for (const lang of ["ta", "kn"]) {
    const script = lang === "ta" ? /[\u0B80-\u0BFF]/ : /[\u0C80-\u0CFF]/;
    for (const [key, fn] of Object.entries(STRINGS.en)) {
      assert.ok(STRINGS[lang][key], `${lang} ${key} missing`);
      assert.equal(holes(STRINGS[lang][key].toString()), holes(fn.toString()), `${lang} ${key} placeholders`);
    }
    for (const key of ["webTitle", "webEnter", "webNote", "toneCalm", "toneHelp", "jsHelp", "jsArrived", "jsGap"]) {
      assert.match(STRINGS[lang][key]({ name: "Ravi", at: "8:30 PM", dead: "" }), script, `${lang} ${key}`);
    }
  }
});

test("Tamil and Kannada sentences, plural and clock", () => {
  const evening = new Date(2026, 9, 28, 20, 5).getTime();
  setLanguage("ta");
  assert.equal(clock(evening), "8:05 PM");
  assert.equal(t.jsAlmost({ n: 1 }), "கிட்டத்தட்ட வந்தாச்சு, இன்னும் சுமார் 1 நிமிஷம்.");
  assert.equal(t.jsHelp({ name: "ரவி" }), "ரவி உதவி கேட்டிருக்காங்க. உடனே கால் பண்ணுங்க.");
  assert.match(dayAndClock(evening, evening), /8:05 PM/);
  setLanguage("kn");
  assert.equal(clock(evening), "8:05 PM");
  assert.equal(t.jsAlmost({ n: 3 }), "ಬಹುತೇಕ ತಲುಪಿದ್ದಾರೆ, ಇನ್ನೂ ಸುಮಾರು 3 ನಿಮಿಷ.");
  assert.equal(t.jsArrived({ name: "ರವಿ" }), "ರವಿ ತಲುಪಿದ್ದಾರೆ.");
  setLanguage("hi");
  assert.equal(clock(evening), "8:05 pm", "Hindi keeps lower-case am/pm");
  setLanguage("en");
  assert.equal(typeof endSentence, "function");
});

test("driver page speaks Tamil and Kannada", site, () => {
  const page = read("drive.html");
  for (const lang of ["ta", "kn"]) assert.match(page, new RegExp(`\\n    ${lang}: \\{\\n      title: "`), lang);
  assert.match(page, /lang=\(en\|hi\|te\|ta\|kn\)/);
  assert.match(page, /Hushmile-ல திறங்க/);
  assert.match(page, /Hushmileನಲ್ಲಿ ತೆರೆಯಿರಿ/);
});

test("privacy page: speech service wording and the notes in each language", site, () => {
  const page = read("privacy.html");
  assert.match(page, /your phone's speech service \(usually Google\)/);
  assert.doesNotMatch(page, /normally Google/);
  assert.match(page, /English, Hindi, Telugu, Tamil or Kannada/);
  for (const lang of ["ta", "kn", "te", "hi"]) assert.match(page, new RegExp(`<details lang="${lang}">`), lang);
  assert.match(page, /\(பெரும்பாலும் Google\)/);
  assert.match(page, /\(ಸಾಮಾನ್ಯವಾಗಿ Google\)/);
});
