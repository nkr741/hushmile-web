// The privacy page answers both stores: deletion, desk data, error reports, data table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../privacy.html", import.meta.url), "utf8");

test("account deletion has its own anchor with the in-app routes and an email route", () => {
  assert.match(page, /<h2 id="delete-account">/);
  assert.match(page, /Delete this company account/);
  assert.match(page, /Leave this desk/);
  assert.match(page, /mailto:support@hushmile\.com\?subject=Delete/);
  assert.match(page, /Questions or data requests: email <a href="mailto:support@hushmile\.com">/);
  // One support address: no other email on the page.
  const emails = new Set(page.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g));
  assert.deepEqual([...emails], ["support@hushmile.com"]);
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

test("the safety features and desk additions are disclosed, in every language", () => {
  // Trusted contacts stay on the phone; the SMS is sent by the person from their own SMS app.
  assert.match(page, /<li id="safety-features">/);
  assert.match(page, /Trusted contact groups<\/strong>[^<]*are kept only on this phone, locked \(encrypted\)[^<]*never sent to Hushmile/);
  assert.match(page, /you press send, and it goes through your mobile network, not through Hushmile/);
  assert.match(page, /Hushmile never sends an SMS and has no SMS permission/);
  assert.match(page, /lock-screen SOS<\/strong> is a notification shown only on this phone while your journey runs/);
  assert.match(page, /arrival message<\/strong>: when the phone has stayed in the destination area/);
  // Drop-off code: what is kept and for how long; the driver never gets it from Hushmile.
  assert.match(page, /<li id="drop-off-code">/);
  assert.match(page, /keeps the code while the trip is open and for one day after it ends/);
  assert.match(page, /a hash of the passenger key \(never the key\)/);
  assert.match(page, /Hushmile never gives it to the driver/);
  assert.match(page, /the message itself does not contain the code/);
  // Document dates: dates only, removed with the company.
  assert.match(page, /<li id="document-dates">/);
  assert.match(page, /Only the dates: no document, photo or document number/);
  assert.match(page, /vehicles, document dates, weekly trips/);
  // The data table has a row for each.
  for (const row of ["Drop-off code and its result (company trips)", "Document expiry dates (company vehicles and drivers)", "Trusted contact groups"]) {
    assert.ok(page.includes(`<tr><td>${row}</td>`), row);
  }
  assert.match(page, /A passenger's drop-off link \(a random key after the <code>#<\/code>\) sends that key only inside a request to api\.hushmile\.com/);
  assert.match(page, /cab reached the area of the destination when the driver's phone closed the trip by itself/);
  // Each language block has the same points: contacts on the phone, SMS, lock screen, arrival, drop-off code, document dates.
  const words = {
    te: [/కాంటాక్ట్స్ గ్రూప్‌లు ఈ ఫోన్‌లోనే/, /SMS/, /లాక్ స్క్రీన్ SOS/, /చేరిక సందేశం/, /డ్రాప్ కోడ్/, /గడువు తేదీలు/, /మెసేజ్‌లో కోడ్ ఉండదు/],
    hi: [/कॉन्टैक्ट्स के ग्रुप सिर्फ़ इसी फ़ोन पर/, /SMS/, /लॉक स्क्रीन वाला SOS/, /पहुँचने का मैसेज/, /ड्रॉप कोड/, /आख़िरी तारीख़ें/, /मैसेज में कोड नहीं होता/],
    ta: [/காண்டாக்ட்ஸ் குழுக்கள் இந்த போன்லயே/, /SMS/, /லாக் ஸ்கிரீன் SOS/, /சேர்ந்த மெசேஜ்/, /டிராப் கோட்/, /காலாவதி தேதிகள்/, /மெசேஜ்ல கோட் இருக்காது/],
    kn: [/ಕಾಂಟ್ಯಾಕ್ಟ್ಸ್ ಗುಂಪುಗಳು ಈ ಫೋನ್‌ನಲ್ಲೇ/, /SMS/, /ಲಾಕ್ ಸ್ಕ್ರೀನ್ SOS/, /ತಲುಪಿದ ಮೆಸೇಜ್/, /ಡ್ರಾಪ್ ಕೋಡ್/, /ಕೊನೆಯ ದಿನಾಂಕಗಳು/, /ಮೆಸೇಜ್‌ನಲ್ಲಿ ಕೋಡ್ ಇರಲ್ಲ/],
  };
  for (const [lang, list] of Object.entries(words)) {
    const block = page.split(`<details lang="${lang}">`)[1].split("</details>")[0];
    for (const re of list) assert.match(block, re, `${lang}: ${re}`);
    // No Latin words in the Indic text except the brand and SOS/SMS.
    const safety = block.split('<p class="safety">')[1].split("</p>")[0];
    assert.deepEqual([...new Set(safety.match(/[A-Za-z]+/g))].filter((w) => !["Hushmile", "SOS", "SMS"].includes(w)), [], lang);
  }
});
