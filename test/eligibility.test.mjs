import test from "node:test";
import assert from "node:assert/strict";
import { checkCompactionEligibility } from "./readiness-fixture.mjs";

const eligible = { ok: true, eligible: true, sessionId: "session-1", leafId: "leaf-1" };

function fixture() {
  const calls = [];
  const pi = { getSettings: () => ({ compaction: { keepRecentTokens: 12_000 } }) };
  const ctx = {
    model: { provider: "test", id: "model-A" },
    sessionManager: { getSessionId: () => "session-1", getLeafId: () => "leaf-1" },
  };
  Object.defineProperty(ctx, "sdkReadiness", {
    configurable: true,
    writable: true,
    value(settings) {
      calls.push({ settings, model: this.model });
      return eligible;
    },
  });
  return { pi, ctx, calls };
}

test("passes the actual current public snapshot to the explicitly injected reader on every call", () => {
  const f = fixture();
  let snapshot = { compaction: { modelOverrides: { "test/model-A": { keepRecentTokens: 42 } } } };
  f.pi.getSettings = function () { assert.equal(this, f.pi); return snapshot; };
  assert.equal(Object.keys(f.ctx).includes("sdkReadiness"), false);
  assert.deepEqual(checkCompactionEligibility(f.pi, f.ctx), { ok: true, sessionId: "session-1" });
  assert.equal(f.calls[0].settings, snapshot);
  assert.equal(f.calls[0].model, f.ctx.model);
  snapshot = { compaction: { modelOverrides: { "test/model-B": { keepRecentTokens: 84 } } } };
  f.ctx.model = { provider: "test", id: "model-B" };
  assert.equal(checkCompactionEligibility(f.pi, f.ctx).ok, true);
  assert.equal(f.calls[1].settings, snapshot);
  assert.equal(f.calls[1].model, f.ctx.model);
  assert.equal(f.calls.length, 2);
});

const malformedResults = [
  undefined, null, [], true, Promise.resolve(eligible), {},
  { ...eligible, ok: 1 }, { ...eligible, eligible: 1 }, { ...eligible, eligible: "true" },
  { ...eligible, eligible: undefined }, { ...eligible, sessionId: undefined },
  { ...eligible, sessionId: "" }, { ...eligible, leafId: undefined },
  { ...eligible, leafId: 1 }, { ...eligible, leafId: "" },
  { ...eligible, reason: {} }, { ok: false }, { ok: false, reason: 12 },
];
for (const [index, value] of malformedResults.entries()) {
  test(`malformed reader result ${index} is refused`, () => {
    const f = fixture();
    f.ctx.sdkReadiness = () => value;
    const result = checkCompactionEligibility(f.pi, f.ctx);
    assert.equal(result.ok, false);
    assert.match(result.reason, /malformed/);
  });
}

for (const settings of [undefined, null, [], true, "private settings", 1, () => ({}), Promise.resolve({})]) {
  test(`malformed snapshot ${typeof settings}/${String(settings)} is refused without calling reader`, () => {
    const f = fixture();
    f.pi.getSettings = () => settings;
    assert.equal(checkCompactionEligibility(f.pi, f.ctx).ok, false);
    assert.equal(f.calls.length, 0);
  });
}

const refusals = [
  { name: "SDK without getSettings", apply(f) { delete f.pi.getSettings; } },
  { name: "nonfunction settings", apply(f) { f.pi.getSettings = {}; } },
  { name: "missing injected reader", apply(f) { delete f.ctx.sdkReadiness; } },
  { name: "nonfunction reader", apply(f) { f.ctx.sdkReadiness = {}; } },
  { name: "settings throws", apply(f) { f.pi.getSettings = () => { throw new Error("PRIVATE CONTENT"); }; } },
  { name: "settings getter throws", apply(f) { Object.defineProperty(f.pi, "getSettings", { get() { throw "PRIVATE CONTENT"; } }); } },
  { name: "reader throws", apply(f) { f.ctx.sdkReadiness = () => { throw "PRIVATE CONTENT"; }; } },
  { name: "reader getter throws", apply(f) { Object.defineProperty(f.ctx, "sdkReadiness", { get() { throw "PRIVATE CONTENT"; } }); } },
  { name: "reader unavailable", apply(f) { f.ctx.sdkReadiness = () => ({ ok: false, reason: "PRIVATE CONTENT" }); } },
  { name: "short boundary", apply(f) { f.ctx.sdkReadiness = () => ({ ...eligible, eligible: false, reason: "PRIVATE CONTENT" }); } },
  { name: "wrong session", apply(f) { f.ctx.sdkReadiness = () => ({ ...eligible, sessionId: "other" }); } },
  { name: "stale branch", apply(f) { f.ctx.sdkReadiness = () => ({ ...eligible, leafId: "other" }); } },
  { name: "session unreadable", apply(f) { f.ctx.sessionManager.getSessionId = () => { throw "PRIVATE CONTENT"; }; } },
  { name: "leaf unreadable", apply(f) { f.ctx.sessionManager.getLeafId = () => { throw "PRIVATE CONTENT"; }; } },
];
for (const refusal of refusals) {
  test(`${refusal.name} fails closed with a content-free reason`, () => {
    const f = fixture();
    refusal.apply(f);
    const result = checkCompactionEligibility(f.pi, f.ctx);
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, "string");
    assert.doesNotMatch(result.reason, /PRIVATE CONTENT/);
  });
}

test("null leaf is valid only when it matches the current branch", () => {
  const f = fixture();
  f.ctx.sdkReadiness = () => ({ ...eligible, leafId: null });
  assert.equal(checkCompactionEligibility(f.pi, f.ctx).ok, false);
  f.ctx.sessionManager.getLeafId = () => null;
  assert.equal(checkCompactionEligibility(f.pi, f.ctx).ok, true);
});
