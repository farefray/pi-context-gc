import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createCompactionReadinessReader, readCompactionReadiness } from '../dist/src/sdk-readiness.js';

const settings = { compaction: { keepRecentTokens: 12 } };
function fixture() {
  const manager = sdk.SessionManager.inMemory('/synthetic-readiness');
  manager.appendMessage({ role: 'user', content: 'Synthetic phase only.', timestamp: 1 });
  let active = true;
  const ctx = { sessionManager: manager, model: { provider: 'fixture', api: 'fixture-api', id: 'fixture-model' },
    get cwd() { if (!active) throw new Error('PRIVATE stale diagnostic'); return '/synthetic-readiness'; } };
  const result = () => ({ ok: true, eligible: true, sessionId: manager.getSessionId(), leafId: manager.getLeafId() });
  return { ctx, manager, result, invalidate() { active = false; } };
}

test('public accessor gets the actual manager/model/settings once without mutation or actions', () => {
  const f = fixture(); const before = structuredClone(f.manager.getEntries()); let calls = 0;
  const reader = createCompactionReadinessReader((input) => {
    calls++; assert.equal(input.sessionManager, f.manager); assert.equal(input.model, f.ctx.model); assert.equal(input.settings, settings);
    return f.result();
  });
  assert.deepEqual(reader(f.ctx, settings), f.result());
  assert.equal(calls, 1); assert.deepEqual(f.manager.getEntries(), before);
});

test('ineligible public result is preserved, without replacing SDK boundary selection', () => {
  const f = fixture();
  const reader = createCompactionReadinessReader(() => ({ ...f.result(), eligible: false, reason: 'nothing-to-compact' }));
  assert.deepEqual(reader(f.ctx, settings), { ...f.result(), eligible: false, reason: 'nothing-to-compact' });
});

test('missing public capability and accessor exceptions refuse without content leakage', () => {
  const f = fixture();
  assert.deepEqual(createCompactionReadinessReader(null)(f.ctx, settings), { ok: false, reason: 'sdk-readiness-unavailable' });
  assert.deepEqual(createCompactionReadinessReader(() => { throw new Error('PRIVATE'); })(f.ctx, settings), { ok: false, reason: 'readiness-failed' });
  assert.deepEqual(createCompactionReadinessReader(() => ({ ok: false, reason: 'PRIVATE path/credential' }))(f.ctx, settings), { ok: false, reason: 'sdk-readiness-failed' });
});

test('malformed/foreign/asynchronous results do not establish readiness', () => {
  const f = fixture();
  for (const result of [null, [], true, Promise.resolve(f.result()), {}, { ...f.result(), eligible: 1 },
    { ...f.result(), sessionId: 'other' }, { ...f.result(), leafId: 'other' }, { ...f.result(), reason: 'PRIVATE secret' }]) {
    assert.deepEqual(createCompactionReadinessReader(() => result)(f.ctx, settings), { ok: false, reason: 'sdk-readiness-invalid-result' });
  }
});

test('public guarded context and session/model changes still revoke readiness', () => {
  for (const kind of ['stale', 'leaf', 'session', 'model']) {
    const f = fixture(); const expected = f.result();
    const reader = createCompactionReadinessReader(() => {
      if (kind === 'stale') f.invalidate();
      if (kind === 'leaf') f.manager.appendCustomEntry('synthetic-mutation', {});
      if (kind === 'session') f.ctx.sessionManager = sdk.SessionManager.inMemory('/different-synthetic-session');
      if (kind === 'model') f.ctx.model = { ...f.ctx.model, id: 'changed-model' };
      return expected;
    });
    const result = reader(f.ctx, settings);
    assert.equal(result.ok, false); assert.doesNotMatch(result.reason, /PRIVATE/);
  }
});

test('equivalent model objects and ordinary public context values are not private identity failures', () => {
  const f = fixture();
  const reader = createCompactionReadinessReader(() => { f.ctx.model = { ...f.ctx.model }; return f.result(); });
  assert.equal(reader(f.ctx, settings).ok, true);
});

test('invalid settings and missing model fail before calling the accessor', () => {
  const f = fixture(); let calls = 0;
  const reader = createCompactionReadinessReader(() => { calls++; return f.result(); });
  for (const invalid of [null, [], true, Promise.resolve({})]) assert.equal(reader(f.ctx, invalid).ok, false);
  delete f.ctx.model;
  assert.deepEqual(reader(f.ctx, settings), { ok: false, reason: 'model-unavailable' });
  assert.equal(calls, 0);
});

test('default route uses only the SDK public capability, never an internal loader fallback', () => {
  const f = fixture();
  const actual = readCompactionReadiness(f.ctx, settings);
  if (typeof sdk.readCompactionReadiness === 'function') {
    assert.deepEqual(actual, sdk.readCompactionReadiness({ sessionManager: f.manager, model: f.ctx.model, settings }));
  } else {
    assert.deepEqual(actual, { ok: false, reason: 'sdk-readiness-unavailable' });
  }
});
