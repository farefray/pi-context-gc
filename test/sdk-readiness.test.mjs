import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPackageDir, SettingsManager, SessionManager, ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { createExtensionRuntime } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { createCompactionReadinessReader, readCompactionReadiness } from '../dist/src/sdk-readiness.js';
import { checkCompactionEligibility } from '../dist/src/eligibility.js';

const require = createRequire(import.meta.url);
const dir = getPackageDir();
const { prepareCompaction } = require(join(dir, 'dist/core/compaction/compaction.js'));
const loader = {
  getPackageDir: () => dir,
  readManifest: path => JSON.parse(readFileSync(path, 'utf8')),
  requireModule: path => require(path),
};
const model = { provider: 'fixture', id: 'model-A' };
function fixture() {
  const manager = SessionManager.inMemory();
  for (let i = 0; i < 6; i++) manager.appendMessage({ role: 'user', content: 'synthetic phase '.repeat(200), timestamp: i });
  const runner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), manager, {});
  runner.getModel = () => model;
  runner.abortFn = runner.compactFn = () => assert.fail('readiness must never abort/compact');
  const ctx = runner.createContext();
  return { ctx, runner, manager };
}
const settings = { compaction: { keepRecentTokens: 12 } };

test('actual pure SDK preparation is the independent readiness oracle; no history mutation', () => {
  const f = fixture();
  const before = structuredClone(f.manager.getBranch());
  const expected = prepareCompaction(f.manager.getBranch(), SettingsManager.inMemory(settings).getCompactionSettings(model));
  assert.ok(expected);
  assert.deepEqual(readCompactionReadiness(f.ctx, settings), { ok: true, eligible: true, sessionId: f.manager.getSessionId(), leafId: f.manager.getLeafId() });
  assert.deepEqual(checkCompactionEligibility({ getSettings: () => settings }, f.ctx), { ok: true, sessionId: f.manager.getSessionId() });
  assert.deepEqual(f.manager.getBranch(), before);
  assert.equal(Object.keys(f.ctx).some(key => key.includes('Preflight')), false);
});

test('current settings/model overrides select eligibility, including short and changed-model cases', () => {
  const f = fixture();
  const snapshot = { compaction: { keepRecentTokens: 1_000_000, modelOverrides: { 'fixture/model-A': { keepRecentTokens: 12 } } } };
  assert.ok(prepareCompaction(f.manager.getBranch(), SettingsManager.inMemory(snapshot).getCompactionSettings(model)));
  assert.equal(readCompactionReadiness(f.ctx, snapshot).eligible, true);
  const other = { provider: 'fixture', id: 'model-B' };
  f.runner.getModel = () => other;
  const ctx = f.runner.createContext();
  assert.equal(prepareCompaction(f.manager.getBranch(), SettingsManager.inMemory(snapshot).getCompactionSettings(other)), undefined);
  assert.equal(readCompactionReadiness(ctx, snapshot).eligible, false);
  assert.equal(checkCompactionEligibility({ getSettings: () => snapshot }, ctx).ok, false);
});

for (const [name, overrides, reason] of [
  ['missing SDK', { getPackageDir() { throw new Error('PRIVATE'); } }, 'sdk-sync-load-failed'],
  ['wrong version', { readManifest: () => ({ name: '@earendil-works/pi-coding-agent', version: '1.3.1' }) }, 'sdk-version-mismatch'],
  ['foreign package', { readManifest: () => ({ name: 'other', version: '1.3.0' }) }, 'sdk-version-mismatch'],
  ['malformed manifest', { readManifest: () => [] }, 'sdk-version-mismatch'],
  ['foreign SDK class', { requireModule: () => ({ SettingsManager: class {} }) }, 'sdk-module-mismatch'],
  ['missing preparation', { requireModule: path => path.endsWith('settings-manager.js') ? { SettingsManager } : {} }, 'sdk-prepare-unavailable'],
]) {
  test(`${name} refuses without action or content leakage`, () => {
    const f = fixture();
    assert.deepEqual(createCompactionReadinessReader({ ...loader, ...overrides })(f.ctx, settings), { ok: false, reason });
  });
}

for (const value of [null, {}, [], true, Promise.resolve({}), { firstKeptEntryId: 'id' }]) {
  test(`malformed preparation ${String(value)} refuses`, () => {
    const reader = createCompactionReadinessReader({ ...loader, requireModule: path => path.endsWith('settings-manager.js') ? { SettingsManager } : { prepareCompaction: () => value } });
    assert.deepEqual(reader(fixture().ctx, settings), { ok: false, reason: 'sdk-prepare-invalid-result' });
  });
}

for (const invalid of [null, [], Promise.resolve({}), { compaction: { keepRecentTokens: -1 } }, { compaction: { modelOverrides: { 'fixture/model-A': { keepRecentTokens: '12' } } } }]) {
  test('invalid snapshot or effective model settings refuse', () => {
    const result = readCompactionReadiness(fixture().ctx, invalid);
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.reason, /PRIVATE/);
  });
}

test('stale real SDK context and a value-only cwd cannot establish readiness', () => {
  const f = fixture();
  f.runner.invalidate();
  assert.deepEqual(readCompactionReadiness(f.ctx, settings), { ok: false, reason: 'context-stale' });
  assert.deepEqual(readCompactionReadiness({ cwd: '/synthetic' }, settings), { ok: false, reason: 'context-guard-unavailable' });
});

for (const mutation of ['stale', 'leaf', 'session', 'model']) {
  test(`context ${mutation} changing during preparation refuses`, () => {
    const f = fixture();
    const reader = createCompactionReadinessReader({ ...loader, requireModule(path) {
      if (path.endsWith('settings-manager.js')) return { SettingsManager };
      return { prepareCompaction(branch, effective) {
        const prepared = prepareCompaction(branch, effective);
        if (mutation === 'stale') f.runner.invalidate();
        if (mutation === 'leaf') f.manager.appendCustomEntry('probe', {});
        if (mutation === 'session') f.manager.getSessionId = () => 'other';
        if (mutation === 'model') Object.defineProperty(f.ctx, 'model', { value: { ...model } });
        return prepared;
      } };
    } });
    assert.equal(reader(f.ctx, settings).ok, false);
  });
}

test('package override never selects an arbitrary SDK, even after earlier success', () => {
  const f = fixture();
  const before = process.env.PI_PACKAGE_DIR;
  try {
    assert.equal(readCompactionReadiness(f.ctx, settings).ok, true);
    process.env.PI_PACKAGE_DIR = dir;
    assert.deepEqual(readCompactionReadiness(f.ctx, settings), { ok: false, reason: 'sdk-package-override' });
  } finally {
    if (before === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = before;
  }
});
