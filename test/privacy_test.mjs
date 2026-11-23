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

test("company-trip live facts (app 1.8.2) are disclosed in every language", () => {
  assert.match(page, /<span id="desk-live">/);
  assert.match(page, /speed, average moving speed and distance driven/);
  assert.match(page, /not an emergency service/);
  assert.doesNotMatch(page, /It does not store the Journey Code or any location/);
  for (const lang of ["ta", "kn", "te", "hi"]) {
    const block = page.split(`<details lang="${lang}">`)[1].split("</details>")[0];
    assert.match(block, /1\.8\.2/, lang);
  }
});
