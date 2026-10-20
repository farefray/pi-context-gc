import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../dist/src/config.js";

const booleanEnv = [
  ["enabled", "PI_CONTEXT_GC_ENABLED"],
  ["autoResume", "PI_CONTEXT_GC_AUTO_RESUME"],
  ["resumeOnFailure", "PI_CONTEXT_GC_RESUME_ON_FAILURE"],
  ["notify", "PI_CONTEXT_GC_NOTIFY"],
];

function fixture(t, trusted = true) {
  const root = mkdtempSync(join(tmpdir(), "context-gc-config-"));
  const saved = new Map(["HOME", "USERPROFILE", ...booleanEnv.map(([, name]) => name),
    "PI_CONTEXT_GC_MIN_CONTEXT_TOKENS"].map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = process.env.HOME;
  for (const [, name] of booleanEnv) delete process.env[name];
  delete process.env.PI_CONTEXT_GC_MIN_CONTEXT_TOKENS;
  assert.equal(homedir(), process.env.HOME);
  const ctx = { cwd: join(root, "project"), isProjectTrusted: () => trusted };
  const globalPath = join(homedir(), ".pi", "agent", "context-gc.json");
  const projectPath = join(ctx.cwd, ".pi", "context-gc.json");
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  mkdirSync(join(ctx.cwd, ".pi"), { recursive: true });
  return {
    ctx, globalPath, projectPath,
    global(value) { writeFileSync(globalPath, JSON.stringify(value)); },
    project(value) { writeFileSync(projectPath, JSON.stringify(value)); },
  };
}

test("missing configuration defaults to minimum zero", (t) => {
  const f = fixture(t);
  assert.equal(DEFAULT_CONFIG.minContextTokens, 0);
  const loaded = loadConfig(f.ctx);
  assert.deepEqual(loaded.config, {
    enabled: true, autoResume: true, resumeOnFailure: false, notify: false, minContextTokens: 0,
  });
  assert.deepEqual(loaded.loadedSources, []);
  assert.deepEqual(loaded.warnings, []);
});

for (const minimum of [0, 150_000, Number.MAX_SAFE_INTEGER]) {
  test(`trusted project accepts minimum ${minimum} over global settings`, (t) => {
    const f = fixture(t);
    f.global({ minContextTokens: 42, notify: true });
    f.project({ minContextTokens: minimum, enabled: false });
    const loaded = loadConfig(f.ctx);
    assert.equal(loaded.config.minContextTokens, minimum);
    assert.equal(loaded.config.notify, true);
    assert.equal(loaded.config.enabled, false);
    assert.deepEqual(loaded.loadedSources, [f.globalPath, f.projectPath]);
    assert.deepEqual(loaded.warnings, []);
  });
}

test("missing project key inherits the valid global minimum", (t) => {
  const f = fixture(t);
  f.global({ minContextTokens: 150_000 });
  f.project({ notify: true });
  const loaded = loadConfig(f.ctx);
  assert.equal(loaded.config.minContextTokens, 150_000);
  assert.equal(loaded.config.notify, true);
  assert.deepEqual(loaded.warnings, []);
});

for (const trust of ["untrusted", "throws"]) {
  test(`${trust} project trust skips local numeric and boolean settings`, (t) => {
    const f = fixture(t, false);
    if (trust === "throws") f.ctx.isProjectTrusted = () => { throw new Error("PRIVATE TRUST"); };
    f.global({ minContextTokens: 150_000 });
    f.project({ minContextTokens: 0, enabled: false });
    const loaded = loadConfig(f.ctx);
    assert.equal(loaded.config.minContextTokens, 150_000);
    assert.equal(loaded.config.enabled, true);
    assert.deepEqual(loaded.loadedSources, [f.globalPath]);
    assert.equal(loaded.warnings.length, trust === "throws" ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(loaded.warnings), /PRIVATE TRUST/);
  });
}

const invalid = [
  ["string", '"PRIVATE CONFIG VALUE"'],
  ["null", "null"],
  ["boolean true", "true"],
  ["boolean false", "false"],
  ["negative", "-123456"],
  ["fraction", "0.25"],
  ["unsafe integer", "9007199254740992"],
  ["positive infinity via JSON exponent", "1e400"],
  ["negative infinity via JSON exponent", "-1e400"],
  ["array", "[]"],
  ["object", '{"private":"PRIVATE CONFIG VALUE"}'],
];
for (const [name, raw] of invalid) {
  for (const layer of ["global", "project"]) {
    test(`invalid ${name} in ${layer} warns without its value and preserves the prior valid layer`, (t) => {
      const f = fixture(t);
      f.global({ minContextTokens: 150_000 });
      f.project({ notify: true });
      const path = layer === "global" ? f.globalPath : f.projectPath;
      writeFileSync(path, `{"minContextTokens":${raw}}`);
      const loaded = loadConfig(f.ctx);
      assert.equal(loaded.config.minContextTokens, layer === "global" ? 0 : 150_000);
      assert.deepEqual(loaded.warnings, [`${path}: minContextTokens must be a nonnegative safe integer`]);
      assert.deepEqual(loaded.loadedSources, [f.globalPath, f.projectPath]);
    });
  }
}

for (const raw of ['{"minContextTokens":NaN,"secret":"PRIVATE JSON"}', '{"secret":"PRIVATE JSON", broken}']) {
  test(`malformed JSON warning never includes raw configuration (${raw.includes("NaN") ? "NaN" : "syntax"})`, (t) => {
    const f = fixture(t);
    f.global({ minContextTokens: 150_000 });
    writeFileSync(f.projectPath, raw);
    const loaded = loadConfig(f.ctx);
    assert.equal(loaded.config.minContextTokens, 150_000);
    assert.deepEqual(loaded.warnings, [`${f.projectPath}: could not read or parse JSON configuration`]);
    assert.deepEqual(loaded.loadedSources, [f.globalPath]);
  });
}

for (const [key, env] of booleanEnv) {
  for (const [raw, expected] of [["1", true], ["0", false], ["true", true], ["false", false],
    ["yes", true], ["no", false], ["on", true], ["off", false], [" TRUE ", true]]) {
    test(`${env}=${raw} overrides only its boolean field`, (t) => {
      const f = fixture(t);
      f.project({ minContextTokens: 150_000, [key]: !expected });
      process.env[env] = raw;
      const loaded = loadConfig(f.ctx);
      assert.equal(loaded.config[key], expected);
      assert.equal(loaded.config.minContextTokens, 150_000);
      assert.deepEqual(loaded.warnings, []);
    });
  }
  test(`invalid ${env} does not leak or replace a valid boolean`, (t) => {
    const f = fixture(t);
    f.project({ minContextTokens: 150_000, [key]: true });
    process.env[env] = "PRIVATE ENV";
    const loaded = loadConfig(f.ctx);
    assert.equal(loaded.config[key], true);
    assert.equal(loaded.config.minContextTokens, 150_000);
    assert.deepEqual(loaded.warnings, [`${env} must be one of 1/0, true/false, yes/no, on/off`]);
  });
}

test("numeric minimum has no environment override", (t) => {
  const f = fixture(t);
  f.project({ minContextTokens: 150_000 });
  process.env.PI_CONTEXT_GC_MIN_CONTEXT_TOKENS = "0";
  assert.equal(loadConfig(f.ctx).config.minContextTokens, 150_000);
});

test("boolean JSON validation remains separate from numeric validation", (t) => {
  const f = fixture(t);
  f.global({ enabled: false, autoResume: false, resumeOnFailure: true, notify: true, minContextTokens: 150_000 });
  f.project({ enabled: 1, autoResume: "true", resumeOnFailure: null, notify: 0, minContextTokens: 0 });
  const loaded = loadConfig(f.ctx);
  assert.deepEqual(loaded.config, {
    enabled: false, autoResume: false, resumeOnFailure: true, notify: true, minContextTokens: 0,
  });
  assert.deepEqual(loaded.warnings, booleanEnv.map(([key]) => `${f.projectPath}: ${key} must be boolean`));
});
