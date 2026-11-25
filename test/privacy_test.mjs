// The privacy page answers both stores: deletion, desk data, error reports, data table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../privacy.html", import.meta.url), "utf8");

test("account deletion has its own anchor with the in-app routes and an email route", () => {
  assert.match(page, /<h2 id="delete-account">/);
  assert.match(page, /Delete this company account/);
  assert.match(page, /Leave this desk/);
  assert.match(page, /mailto:ryvantechnologies@gmail\.com\?subject=Delete/);
});

test("error reports are described as opt-in and no longer denied", () => {
  assert.match(page, /Error reports are off unless you turn them on/);
  assert.doesNotMatch(page, /do not use advertising, analytics, crash reporting/);
});

test("location says it continues when the app is closed or not in use", () => {
  assert.match(page, /including when the app is closed or not in use/);
});

test("the data table and desk fields are listed", () => {
  assert.match(page, /<h2 id="data-collected">/);
  assert.match(page, /<p id="desk-fields">/);
  assert.match(page, /Kept 30 days from creation/);
  for (const lang of ["ta", "kn", "te", "hi"]) {
    const block = page.split(`<details lang="${lang}">`)[1].split("</details>")[0];
    assert.match(block, /200/, lang);
  }
});

test("the travel desk is not offered for school buses", () => {
  assert.doesNotMatch(page, /school bus/i);
  assert.match(page, /aged 18 and over/);
});

test("company-trip live facts and fuel fills are disclosed in every language", () => {
  assert.match(page, /<span id="desk-live">/);
  assert.match(page, /speed, average moving speed and distance driven/);
  assert.match(page, /not an emergency service/);
  assert.doesNotMatch(page, /It does not store the Journey Code or any location/);
  assert.match(page, /note a fuel fill on the trip/);
  assert.match(page, /no bill photo is taken or stored/);
  assert.match(page, /Fuel fills on a company trip/);
  // Each language says the company desk sees the vehicle's place and speed
  // during a company trip. No app version is named: the Play version (1.8.x)
  // and the new build numbers (1.x) would read as contradictory.
  const desk = { ta: /டெஸ்க்/, kn: /ಡೆಸ್ಕ್/, te: /డెస్క్/, hi: /डेस्क/ };
  for (const lang of ["ta", "kn", "te", "hi"]) {
    const block = page.split(`<details lang="${lang}">`)[1].split("</details>")[0];
    assert.match(block, desk[lang], lang);
  }
  assert.doesNotMatch(page, /app version 1\.0\.0|build 122/);
});

test("the app version appears once, stamped from the app's pubspec.yaml", () => {
  // Written by tool/stamp_privacy_version.py in the app repo (the page allows
  // no script). No other line names a fixed app version or build, so nothing
  // else goes stale with the next release.
  const stamped = page.match(/<span id="app-version">([0-9]+\.[0-9]+\.[0-9]+), build ([0-9]+)<\/span>/g) || [];
  assert.equal(stamped.length, 1);
  assert.doesNotMatch(page.replace(/<span id="app-version">[^<]*<\/span>/, ""), /app version [0-9]|build [0-9]{3}|\(app [0-9]+\.[0-9]+|from app [0-9]|on app [0-9]|versions before [0-9]/i);
  assert.match(page, /Last updated [0-9]{1,2} [A-Z][a-z]+ 20[0-9]{2} \(app version <span id="app-version">/);
});

test("WhatsApp trip messages are disclosed, in every language", () => {
  assert.match(page, /<h3 id="whatsapp">/);
  assert.match(page, /Meta's WhatsApp Business Platform/);
  assert.match(page, /only for a booking where the office marked that the passenger agreed/);
  assert.match(page, /no advertising or marketing messages are sent/);
  assert.match(page, /Meta WhatsApp Business Platform<\/strong>/);
  assert.match(page, /WhatsApp trip messages, company trips/);
  assert.doesNotMatch(page, /Hushmile does not send it and does not see it/);
  for (const lang of ["ta", "kn", "te", "hi"]) {
    const block = page.split(`<details lang="${lang}">`)[1].split("</details>")[0];
    assert.match(block, /(మెటా|मेटा|மெட்டா|ಮೆಟಾ)/, lang);
  }
});
