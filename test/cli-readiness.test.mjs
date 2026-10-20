import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPackageDir } from '@earendil-works/pi-coding-agent';

for (const bundled of [false, true]) {
  test(`actual ${bundled ? 'bundled CLI refuses (unsupported distribution)' : 'unbundled CLI/Jiti compacts and resumes with fake inference'}`, { timeout: 45000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'context-gc-cli-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const agent = join(home, 'agent');
    const cwd = join(root, 'project');
    const temp = join(root, 'temp');
    for (const dir of [agent, cwd, temp]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 10 }, cacheWarming: 'off', retry: { enabled: false } }));
    const preload = join(root, 'deny-network.mjs');
    writeFileSync(preload, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
const deny=()=>{ throw new Error('Offline fixture forbids network'); }; globalThis.fetch=deny; http.request=http.get=https.request=https.get=deny; net.connect=net.createConnection=tls.connect=deny;`);
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, PI_OFFLINE: '1',
      PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(home, 'sessions'), GC_PROBE_RESULT: join(root, 'proof.json') });
    const sdk = process.env.GC_HOST_SDK ?? getPackageDir();
    const args = ['--import', pathToFileURL(preload).href, join(sdk, bundled ? 'dist/bundle/cli.js' : 'dist/cli.js'), '--mode', 'rpc',
      '--no-session', '--no-extensions', '--no-mcp', '--no-builtin-tools', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
      '--offline', '--no-approve', '--provider', 'gc-offline-proof', '--model', 'fixture', '--tools', 'compact_context',
      '-e', fileURLToPath(new URL('./fixtures/sdk-route.ts', import.meta.url))];
    // Only the scheduler tool is enabled; no built-in tools are named.
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', sent = false, proof, timeout = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const deadline = setTimeout(() => { timeout = true; child.kill(); }, 30000);
    const poll = setInterval(() => {
      try { if (existsSync(env.GC_PROBE_RESULT)) proof = JSON.parse(readFileSync(env.GC_PROBE_RESULT, 'utf8')); } catch { return; }
      if (!proof) return;
      if (!sent) {
        sent = true;
        child.stdin.write(JSON.stringify({ id: 'synthetic-proof', type: 'prompt', message: 'Perform the synthetic two-phase fixture only.' }) + '\n');
      }
      if (proof.settled && typeof proof.accepted === 'boolean' && (bundled || proof.resumes === 1)) child.stdin.end();
    }, 50);
    const status = await new Promise(resolve => child.once('close', resolve));
    clearTimeout(deadline); clearInterval(poll);
    if (existsSync(env.GC_PROBE_RESULT)) proof = JSON.parse(readFileSync(env.GC_PROBE_RESULT, 'utf8'));
    if (process.env.GC_EVIDENCE_ROOT) {
      const label = bundled ? 'bundled' : 'unbundled';
      writeFileSync(join(process.env.GC_EVIDENCE_ROOT, `${label}-cli.json`), JSON.stringify({ command: [process.execPath, ...args], sdk, status, timeout, proof }, null, 2));
      writeFileSync(join(process.env.GC_EVIDENCE_ROOT, `${label}-cli.stdout.log`), stdout);
      writeFileSync(join(process.env.GC_EVIDENCE_ROOT, `${label}-cli.stderr.log`), stderr);
    }
    assert.equal(timeout, false, stderr + '\n' + JSON.stringify(proof));
    assert.equal(status, 0, stderr);
    assert.ok(proof, stderr);
    assert.equal(proof.privateHookPresent, false);
    assert.equal(proof.oracleEligible, true);
    assert.equal(proof.identity, !bundled);
    assert.equal(proof.accepted, !bundled);
    if (bundled) {
      assert.deepEqual(proof.eligible, { ok: false, reason: 'sdk-module-mismatch' });
      assert.equal(proof.compactions, 0);
      assert.equal(proof.resumes, 0);
    } else {
      assert.equal(proof.short.ok, true);
      assert.equal(proof.short.eligible, false);
      assert.equal(proof.eligible.eligible, true);
      assert.equal(proof.compactions, 1);
      assert.equal(proof.preparationMatches, true);
      assert.equal(proof.completeBatch, true);
      assert.equal(proof.resumes, 1);
    }
    assert.equal(proof.settled, true);
    assert.ok(proof.calls >= 2 && proof.calls <= 3, JSON.stringify(proof));
  });
}
