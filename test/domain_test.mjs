import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("CNAME is the watch subdomain only", () => {
  const cname = read("CNAME").trim();
  assert.equal(cname, "watch.hushmile.com");
  assert.doesNotMatch(cname, /^https?:/i);
  assert.doesNotMatch(cname, /\n/);
});

test("privacy canonical and policy name the new host, and keep old links working", () => {
  const page = read("privacy.html");
  assert.match(page, /href="https:\/\/watch\.hushmile\.com\/privacy\.html"/);
  assert.match(page, /watch\.hushmile\.com/);
  assert.match(page, /nkr741\.github\.io\/hushmile-web/);
});

test("compat pages and 404 keep the hash when leaving /hushmile-web/", () => {
  for (const path of ["hushmile-web/index.html", "hushmile-web/privacy.html", "hushmile-web/drive.html", "404.html"]) {
    assert.equal(existsSync(join(root, path)), true, path);
    const html = read(path);
    assert.match(html, /location\.replace\(.*location\.search \+ location\.hash\)/);
    assert.match(html, /hushmile-web/);
  }
});

test("viewer pages use relative asset paths, no /hushmile-web/ base", () => {
  for (const path of ["index.html", "drive.html", "privacy.html", "app.js"]) {
    const text = read(path);
    assert.doesNotMatch(text, /href="\/hushmile-web/);
    assert.doesNotMatch(text, /src="\/hushmile-web/);
    assert.doesNotMatch(text, /<base /i);
  }
  assert.match(read("index.html"), /src="\.\/app\.js"/);
  assert.match(read("index.html"), /href="\.\/vendor\/leaflet\.css"/);
});
