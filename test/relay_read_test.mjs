// node --test test/  — reading both relays, since=<id>, Retry-After (load test, Oct 2026).
import assert from "node:assert/strict";
import test from "node:test";
import { busyWaitMs, FALLBACK_RELAY, latest, PRIMARY_RELAY, relayResting, resetReads, sealFor, topicFor } from "../hushmile-viewer.js";

const CODE = "RT23-YU45";

function fakeRelays() {
  const state = { asked: [], msgs: { [PRIMARY_RELAY]: [], [FALLBACK_RELAY]: [] }, busy: {}, n: 0 };
  state.add = async (relay, body) => {
    state.n++;
    state.msgs[relay].push({ id: `m${state.n}`, event: "message", time: 100 + state.n, message: await sealFor(CODE, "spot", JSON.stringify(body)) });
  };
  state.fetcher = async (url) => {
    state.asked.push(url);
    const u = new URL(url);
    const relay = `${u.protocol}//${u.host}`;
    if (state.busy[relay]) return { ok: false, status: state.busy[relay], headers: { get: (h) => (h === "Retry-After" ? "60" : null) }, text: async () => "" };
    const since = u.searchParams.get("since");
    const all = state.msgs[relay];
    const at = all.findIndex((m) => m.id === since);
    const out = at >= 0 ? all.slice(at + 1) : all;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => out.map((m) => JSON.stringify(m)).join("\n") };
  };
  return state;
}

test("reads api.hushmile.com first and ntfy.sh as the fallback, newest wins", async () => {
  resetReads();
  const r = fakeRelays();
  await r.add(PRIMARY_RELAY, { km: 1 });
  await r.add(FALLBACK_RELAY, { km: 2 });
  const got = await latest(CODE, "spot", "3h", r.fetcher);
  assert.equal(got.km, 2);
  assert.ok(r.asked.some((u) => u.startsWith("https://api.hushmile.com/")));
  assert.ok(r.asked.some((u) => u.startsWith("https://ntfy.sh/")));
});

test("after the first read, only newer messages are asked for (since=<id>)", async () => {
  resetReads();
  const r = fakeRelays();
  for (let i = 1; i <= 10; i++) await r.add(PRIMARY_RELAY, { km: i });
  assert.equal((await latest(CODE, "spot", "3h", r.fetcher)).km, 10);
  r.asked.length = 0;
  assert.equal((await latest(CODE, "spot", "3h", r.fetcher)).km, 10, "nothing new: still the newest");
  const topic = await topicFor(CODE, "spot");
  assert.ok(r.asked.includes(`${PRIMARY_RELAY}/${topic}/json?poll=1&since=m10`));
  await r.add(PRIMARY_RELAY, { km: 11 });
  assert.equal((await latest(CODE, "spot", "3h", r.fetcher)).km, 11);
});

test("a 429 with Retry-After rests that relay; the other still answers", async () => {
  resetReads();
  const r = fakeRelays();
  await r.add(FALLBACK_RELAY, { km: 5 });
  r.busy[PRIMARY_RELAY] = 429;
  assert.equal((await latest(CODE, "spot", "3h", r.fetcher)).km, 5);
  assert.equal(relayResting(PRIMARY_RELAY), true);
  r.asked.length = 0;
  await latest(CODE, "spot", "3h", r.fetcher);
  assert.ok(!r.asked.some((u) => u.startsWith(PRIMARY_RELAY)), "not asked inside Retry-After");
  assert.equal(busyWaitMs("30", 0), 30000);
  assert.equal(busyWaitMs("Fri, 23 Oct 2026 12:00:40 GMT", 0, Date.parse("Fri, 23 Oct 2026 12:00:00 GMT")), 40000);
  const backoff = busyWaitMs(null, 2);
  assert.ok(backoff >= 60000 && backoff < 75000);
  assert.equal(busyWaitMs("999999", 0), 600000);
  resetReads();
});
