import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextGcExtension } from "./readiness-fixture.mjs";

function harness(options) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  const sent = [];
  const callbacks = { value: undefined };
  const contextEntries = [];
  const pi = {
    getSettings: () => ({ compaction: { keepRecentTokens: 20_000 } }),
    on(name, handler) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(type, data) { entries.push({ type, data }); return `entry-${entries.length}`; },
    sendMessage(message, options) { sent.push({ message, options }); },
  };
  const ctx = {
    cwd: "/tmp/project",
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: {
      getSessionId: () => "session-1",
      getLeafId: () => "leaf-1",
      buildContextEntries: () => contextEntries,
    },
    sdkReadiness: () => ({ ok: true, eligible: true, sessionId: "session-1", leafId: "leaf-1" }),
    isProjectTrusted: () => false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 100_000, contextWindow: 350_000, percent: 28.57 }),
    compact(options) { callbacks.value = options; },
  };
  createContextGcExtension(options)(pi);
  return { pi, ctx, handlers, tools, commands, entries, sent, callbacks, contextEntries };
}

async function emit(f, name, event) {
  for (const handler of f.handlers.get(name) ?? []) await handler(event, f.ctx);
}

const input = {
  completed_phase: "phase A complete",
  next_focus: "phase B",
  keep: ["decision one"],
  open_loops: ["finish migration"],
  ruled_out: ["old hypothesis"],
  verification: ["unit tests pass"],
};

function batch(id) {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "compact_context", arguments: input }],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "compact_context",
      isError: false,
      content: [{ type: "text", text: "queued" }],
    },
  ];
}

function configure(t, f, config = { minContextTokens: 150_000 }) {
  const root = mkdtempSync(join(tmpdir(), "context-gc-extension-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  f.ctx.cwd = root;
  f.ctx.isProjectTrusted = () => true;
  mkdirSync(join(root, ".pi"));
  const write = (value) => writeFileSync(join(root, ".pi", "context-gc.json"), JSON.stringify(value));
  write(config);
  return write;
}

async function policyStart(f, systemPrompt = "Foreign system prompt", extra = {}) {
  const event = {
    type: "before_agent_start", systemPrompt,
    ...extra,
  };
  const before = structuredClone(event);
  let returned;
  for (const handler of f.handlers.get("before_agent_start") ?? []) {
    returned = await handler(event, f.ctx);
  }
  assert.deepEqual(event, before, "policy must not mutate the incoming event or structured prompt options");
  return returned;
}

function modernStartEvent(f, extra = {}) {
  return {
    type: "before_agent_start", messageType: "user", prompt: "ordinary input",
    systemPrompt: "Already rendered foreign prompt snapshot",
    systemPromptOptions: {
      cwd: f.ctx.cwd,
      selectedTools: ["read", "compact_context"],
      toolSnippets: { read: "foreign snippet" },
      toolGuidelines: { read: ["foreign tool guideline"] },
      promptGuidelines: ["foreign prompt guideline"],
      appendSystemPrompt: "foreign append",
      sections: { foreign: "foreign section before GC", tool_guidance: "foreign tool guidance" },
      contextFiles: [{ path: "AGENTS.md", content: "foreign project instructions" }],
      skills: [],
    },
    ...extra,
  };
}

async function modernPolicyStart(f, event = modernStartEvent(f)) {
  const before = structuredClone(event);
  const options = event.systemPromptOptions;
  const sections = options.sections;
  for (const handler of f.handlers.get("before_agent_start") ?? []) {
    assert.equal(await handler(event, f.ctx), undefined, "structured hook must not return systemPrompt or force a prompt replacement");
  }
  assert.equal(event.systemPromptOptions, options, "options identity is preserved");
  assert.equal(options.sections, sections, "section record identity is preserved");
  const body = sections["pi-context-gc-policy"];
  if (body !== undefined) before.systemPromptOptions.sections["pi-context-gc-policy"] = body;
  assert.deepEqual(event, before, "GC may change only its own section, not foreign sections, options or forceSystemPrompt");
  return { event, body };
}

for (const tokens of [149_999, 150_000, 150_001]) {
  test(`structured first-request policy uses its own section at usage ${tokens}`, async (t) => {
    const f = admittedHarness();
    configure(t, f);
    f.ctx.getContextUsage = () => ({ tokens });
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    const { event, body } = await modernPolicyStart(f);
    assert.match(body, /Semantic GC minimum: 150000 context tokens/);
    assert.doesNotMatch(body, /Current SDK usage:/);
    assert.match(body, /minimum does not establish readiness/);
    assert.match(body, /Do not prepare a checkpoint or call compact_context merely to discover the minimum/);
    assert.match(body, /never just before the final answer/);
    assert.doesNotMatch(body, /<\/?pi-context-gc-policy>/);
    assert.equal(Object.hasOwn(event.systemPromptOptions, "forceSystemPrompt"), false);
    assert.deepEqual(f.entries, []);
    const response = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    assert.equal(response.details.accepted, tokens >= 150_000);
  });
}

for (const usage of [
  { name: "unknown", read: () => undefined },
  { name: "invalid", read: () => ({ tokens: NaN }) },
  { name: "throwing", read: () => { throw new Error("PRIVATE USAGE"); } },
]) {
  test(`structured policy stays static with ${usage.name} usage without forcing a full prompt`, async (t) => {
    const f = harness();
    configure(t, f);
    f.ctx.getContextUsage = usage.read;
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    const { body } = await modernPolicyStart(f);
    assert.match(body, /minimum: 150000 context tokens/);
    assert.doesNotMatch(body, /Current SDK usage:/);
    assert.doesNotMatch(body, /PRIVATE USAGE|NaN/);
  });
}

for (const state of ["inactive", "disabled", "zero"]) {
  test(`structured ${state} session leaves every option and section unchanged without reading usage`, async (t) => {
    const f = state === "inactive" ? admittedHarness() : harness();
    configure(t, f, { minContextTokens: state === "zero" ? 0 : 150_000, enabled: state !== "disabled" });
    if (state === "inactive") f.admission.admit = false;
    f.ctx.getContextUsage = () => assert.fail("disabled policy must not read usage");
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    const { event, body } = await modernPolicyStart(f);
    assert.equal(body, undefined);
    assert.equal(Object.hasOwn(event.systemPromptOptions.sections, "pi-context-gc-policy"), false);
    assert.equal(Object.hasOwn(event.systemPromptOptions, "forceSystemPrompt"), false);
    assert.deepEqual(f.entries, []);
    assert.deepEqual(f.sent, []);
  });
}

test("structured policy refreshes only its own key across starts, custom resume, foreign updates and reopen", async (t) => {
  const f = harness();
  configure(t, f);
  let tokens = 150_000;
  f.ctx.getContextUsage = () => ({ tokens });
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const first = await modernPolicyStart(f);
  const repeated = await modernPolicyStart(f, first.event);
  assert.equal(repeated.body, first.body);

  // A later extension's supported section update must remain available to the
  // SDK builder, rather than being masked by a forced string from this hook.
  const laterExtension = (event) => {
    event.systemPromptOptions.sections.foreign = "foreign section updated after GC";
    event.systemPromptOptions.sections["foreign-later"] = "positioned declarations added later";
  };
  laterExtension(first.event);
  assert.equal(Object.hasOwn(first.event.systemPromptOptions, "forceSystemPrompt"), false);
  assert.equal(first.event.systemPromptOptions.sections.foreign, "foreign section updated after GC");
  assert.equal(first.event.systemPromptOptions.sections["foreign-later"], "positioned declarations added later");

  tokens = 160_000;
  const customEvent = { ...first.event, messageType: "custom",
    message: { customType: "pi-context-gc-resume", content: "checkpoint", display: false } };
  delete customEvent.prompt;
  const custom = await modernPolicyStart(f, customEvent);
  assert.equal(custom.body, first.body, "usage changes must not rewrite policy across custom continuations");
  assert.doesNotMatch(custom.body, /Current SDK usage:|<\/?pi-context-gc-policy>/);
  assert.equal(Object.keys(custom.event.systemPromptOptions.sections).filter((key) => key === "pi-context-gc-policy").length, 1);
  assert.equal(custom.event.systemPromptOptions.sections.foreign, "foreign section updated after GC");
  assert.equal(custom.event.systemPromptOptions.sections["foreign-later"], "positioned declarations added later");
  await emit(f, "session_start", { type: "session_start", reason: "resume" });
  const reopened = await modernPolicyStart(f, custom.event);
  assert.equal(reopened.body, custom.body);
  assert.deepEqual(f.entries, []);
  assert.deepEqual(f.sent, []);
});

for (const mode of ["structured", "legacy"]) {
  test(`${mode} policy bytes are independent of usage and never query its getter`, async (t) => {
    const f = harness();
    const writeConfig = configure(t, f);
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    const render = async () => mode === "structured"
      ? (await modernPolicyStart(f)).body
      : (await policyStart(f)).systemPrompt;
    let reads = 0;
    let baseline;
    for (const usage of [0, 149_999, 150_000, 250_000, undefined, NaN, "throw"]) {
      f.ctx.getContextUsage = () => {
        reads++;
        if (usage === "throw") throw new Error("PRIVATE USAGE");
        return usage === undefined ? undefined : { tokens: usage };
      };
      const policy = await render();
      baseline ??= policy;
      assert.equal(policy, baseline, "unchanged policy must retain identical bytes across usage changes");
      assert.equal(reads, 0, "advisory policy must not read dynamic SDK usage, even if errors would be caught");
      assert.doesNotMatch(policy, /Current SDK usage:|PRIVATE USAGE|NaN/);
    }
    writeConfig({ minContextTokens: 200_000 });
    await emit(f, "session_start", { type: "session_start", reason: "resume" });
    const changed = await render();
    assert.notEqual(changed, baseline, "a real config change must not be hidden to preserve a cache hit");
    assert.match(changed, /minimum: 200000 context tokens/);
    assert.doesNotMatch(changed, /minimum: 150000 context tokens/);
    assert.equal(reads, 0);
    assert.deepEqual(f.entries, []);
    assert.deepEqual(f.sent, []);
  });
}

test("structured policy preserves a foreign forceSystemPrompt without overwriting or returning it", async (t) => {
  const f = harness();
  configure(t, f);
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const event = modernStartEvent(f);
  event.systemPromptOptions.forceSystemPrompt = "A foreign extension's explicit replacement";
  const { body } = await modernPolicyStart(f, event);
  assert.match(body, /Semantic GC minimum: 150000/);
  assert.equal(event.systemPromptOptions.forceSystemPrompt, "A foreign extension's explicit replacement");
});

for (const sections of [null, undefined, [], "invalid sections"]) {
  test(`a malformed present structured API (${String(sections)}) never falls back to a forced string`, async (t) => {
    const f = harness();
    configure(t, f);
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    assert.equal(await policyStart(f, "Foreign prompt", { systemPromptOptions: { sections } }), undefined);
  });
}

test("legacy flat prompt options without a section API still use string fallback", async (t) => {
  const f = harness();
  configure(t, f);
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const response = await policyStart(f, "Foreign prompt", {
    systemPromptOptions: { cwd: f.ctx.cwd, promptGuidelines: ["foreign legacy guideline"] },
  });
  assert.ok(response.systemPrompt.startsWith("Foreign prompt\n\n<pi-context-gc-policy>\n"));
});

for (const tokens of [149_999, 150_000, 150_001]) {
  test(`first-request policy precedes tool execution at usage ${tokens}`, async (t) => {
    const f = harness();
    configure(t, f);
    f.ctx.getContextUsage = () => ({ tokens, contextWindow: 350_000 });
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    assert.equal(f.entries.length, 0);
    const foreign = "Foreign prompt\n<declarations>positioned declaration</declarations>\nForeign tail";
    const policy = await policyStart(f, foreign, { prompt: "ordinary user input" });
    assert.ok(policy.systemPrompt.startsWith(foreign + "\n\n"));
    assert.match(policy.systemPrompt, /Semantic GC minimum: 150000 context tokens/);
    assert.doesNotMatch(policy.systemPrompt, /Current SDK usage:/);
    assert.match(policy.systemPrompt, /minimum does not establish readiness/);
    assert.match(policy.systemPrompt, /Do not prepare a checkpoint or call compact_context merely to discover the minimum/);
    assert.match(policy.systemPrompt, /never just before the final answer/);
    assert.equal(f.entries.length, 0);
    const response = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    assert.equal(response.details.accepted, tokens >= 150_000);
    if (tokens < 150_000) {
      assert.match(response.content[0].text, /150000.*149999/);
      assert.match(response.content[0].text, /Continue current work/);
      assert.deepEqual(f.entries, []);
      assert.equal(f.callbacks.value, undefined);
      assert.deepEqual(f.sent, []);
    } else {
      assert.equal(response.details.tokensAtRequest, tokens);
      assert.equal(f.entries.length, 1);
    }
  });
}

for (const usage of [
  { name: "undefined", read: () => undefined },
  { name: "null", read: () => ({ tokens: null }) },
  { name: "NaN", read: () => ({ tokens: NaN }) },
  { name: "Infinity", read: () => ({ tokens: Infinity }) },
  { name: "negative", read: () => ({ tokens: -1 }) },
  { name: "throw", read: () => { throw new Error("PRIVATE USAGE"); } },
]) {
  test(`static policy and runtime refusal preserve ${usage.name} usage safety without leaking values`, async (t) => {
    const f = harness();
    configure(t, f);
    f.ctx.getContextUsage = usage.read;
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    const policy = await policyStart(f);
    assert.match(policy.systemPrompt, /minimum: 150000 context tokens/);
    assert.doesNotMatch(policy.systemPrompt, /Current SDK usage:/);
    assert.doesNotMatch(policy.systemPrompt, /PRIVATE USAGE|NaN|Infinity/);
    const response = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    assert.equal(response.details.accepted, false);
    assert.match(response.content[0].text, /150000.*unknown/);
    assert.match(response.content[0].text, /Continue current work/);
    assert.deepEqual(f.entries, []);
    assert.deepEqual(f.sent, []);
    assert.equal(f.callbacks.value, undefined);
  });
}

for (const state of ["inactive", "disabled", "zero"]) {
  test(`${state} sessions do not append minimum policy or read usage`, async (t) => {
    const f = state === "inactive" ? admittedHarness() : harness();
    configure(t, f, { minContextTokens: state === "zero" ? 0 : 150_000, enabled: state !== "disabled" });
    if (state === "inactive") f.admission.admit = false;
    f.ctx.getContextUsage = () => assert.fail("no minimum policy usage read expected");
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    assert.equal(await policyStart(f), undefined);
    assert.deepEqual(f.entries, []);
    assert.equal(f.tools.get("compact_context").exposure, state === "inactive" ? "hidden" : "model-only");
    if (state !== "zero") {
      const response = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
      assert.equal(response.details.reason, state);
    }
  });
}

test("policy appends once on repeated starts, custom resume and reopen without foreign prompt loss", async (t) => {
  const f = harness();
  configure(t, f);
  let tokens = 150_000;
  f.ctx.getContextUsage = () => ({ tokens });
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const foreign = "Foreign system prompt\n<section id=\"other\">foreign update</section>";
  const first = await policyStart(f, foreign);
  const repeat = await policyStart(f, foreign);
  assert.deepEqual(repeat, first, "identical inputs produce a stable append");
  tokens = 160_000;
  const tail = "\nForeign extension appended afterward";
  const custom = await policyStart(f, first.systemPrompt + tail, {
    messageType: "custom", message: { customType: "pi-context-gc-resume", content: "checkpoint", display: false },
  });
  assert.ok(custom.systemPrompt.startsWith(foreign + tail + "\n\n"));
  assert.equal(custom.systemPrompt.split("<pi-context-gc-policy>").length - 1, 1);
  assert.equal(custom.systemPrompt, foreign + tail + first.systemPrompt.slice(foreign.length),
    "only the foreign tail may change, not the policy when usage changes");
  assert.doesNotMatch(custom.systemPrompt, /Current SDK usage:/);
  await emit(f, "session_start", { type: "session_start", reason: "resume" });
  const reopened = await policyStart(f, custom.systemPrompt);
  assert.deepEqual(reopened, custom);
  assert.deepEqual(f.entries, []);
  assert.deepEqual(f.sent, []);
});

test("prompt, execute, boundary, retry and status share the cached config until session_start resets it", async (t) => {
  const f = harness();
  const write = configure(t, f);
  let tokens = 175_000;
  f.ctx.getContextUsage = () => ({ tokens });
  const notices = [];
  f.ctx.hasUI = true;
  f.ctx.ui.notify = (text) => notices.push(text);
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  write({ minContextTokens: 200_000 });
  assert.match((await policyStart(f)).systemPrompt, /minimum: 150000/);
  assert.equal((await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx)).details.accepted, true);
  await f.commands.get("context-gc").handler("status", f.ctx);
  assert.match(notices.at(-1), /minimum context tokens: 150000/);

  await emit(f, "session_start", { type: "session_start", reason: "resume" });
  assert.match((await policyStart(f)).systemPrompt, /minimum: 200000/);
  const response = await f.tools.get("compact_context").execute("tool-2", input, undefined, undefined, f.ctx);
  assert.equal(response.details.accepted, false);
  assert.match(response.details.reason, /200000.*175000/);
  await f.commands.get("context-gc").handler("status", f.ctx);
  assert.match(notices.at(-1), /minimum context tokens: 200000/);

  tokens = 200_000;
  assert.equal((await f.tools.get("compact_context").execute("tool-3", input, undefined, undefined, f.ctx)).details.accepted, true);
  f.contextEntries.push(...batch("tool-3").map((message) => ({ type: "message", message })));
  tokens = 199_999;
  await emit(f, "context", { type: "context", messages: batch("tool-3") });
  assert.equal(f.callbacks.value, undefined);
  assert.equal(f.entries.at(-1).data.status, "requested", "context pause must not change the request leaf");
  await f.commands.get("context-gc").handler("status", f.ctx);
  assert.match(notices.at(-1), /phase: failed/);
  assert.match(notices.at(-1), /200000.*199999/);
  await emit(f, "agent_settled", { type: "agent_settled", aborted: false });
  assert.match(f.entries.at(-1).data.error, /200000.*199999/);
  tokens = null;
  await f.commands.get("context-gc").handler("retry", f.ctx);
  assert.equal(f.callbacks.value, undefined);
  assert.match(f.entries.at(-1).data.error, /200000.*unknown/);
  tokens = 200_000;
  await f.commands.get("context-gc").handler("retry", f.ctx);
  assert.ok(f.callbacks.value);
  f.callbacks.value.onComplete({ tokensBefore: 200_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sent.length, 1);
});

test("stable minimum policy never authorizes a later below-minimum tool request", async (t) => {
  const f = harness();
  configure(t, f);
  f.ctx.getContextUsage = () => ({ tokens: 150_000 });
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const first = (await policyStart(f)).systemPrompt;
  assert.match(first, /minimum: 150000/);
  f.ctx.getContextUsage = () => ({ tokens: 149_999 });
  assert.equal((await policyStart(f)).systemPrompt, first);
  const response = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  assert.equal(response.details.accepted, false);
  assert.deepEqual(f.entries, []);
});

test("above-minimum tool still refuses an ineligible SDK boundary", async (t) => {
  const f = harness();
  configure(t, f);
  f.ctx.getContextUsage = () => ({ tokens: 150_001 });
  f.ctx.sdkReadiness = () => ({ ok: true, eligible: false, sessionId: "session-1", leafId: "leaf-1" });
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const response = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  assert.equal(response.details.accepted, false);
  assert.match(response.details.reason, /no eligible compaction boundary/);
  assert.deepEqual(f.entries, []);
  assert.equal(f.callbacks.value, undefined);
});

test("tool guidelines prohibit minimum probing and final-answer boundaries", () => {
  const f = harness();
  const guidelines = f.tools.get("compact_context").promptGuidelines.join("\n");
  assert.match(guidelines, /minimum and exact SDK eligibility/);
  assert.match(guidelines, /When a positive minimum applies/);
  assert.match(guidelines, /without preparing a checkpoint or probing/);
  assert.match(guidelines, /just before returning the final answer/);
  assert.doesNotMatch(guidelines, /do not wait for context pressure/);
});

test("registers a model-only sequential tool and lifecycle handlers", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const tool = f.tools.get("compact_context");
  assert.ok(tool);
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.exposure, "model-only");
  assert.ok(f.commands.has("context-gc"));
  assert.ok(f.handlers.has("context"));
  assert.ok(f.handlers.has("input"));
});

test("real user input cancels a pending semantic checkpoint", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const tool = f.tools.get("compact_context");
  const first = await tool.execute("tool-1", input, undefined, undefined, f.ctx);
  assert.equal(first.details.accepted, true);

  await emit(f, "input", { type: "input", text: "change direction", source: "interactive" });
  assert.equal(f.entries.at(-1).data.status, "cancelled");

  const second = await tool.execute("tool-2", input, undefined, undefined, f.ctx);
  assert.equal(second.details.accepted, true);
});


for (const aborted of [false, true]) {
  test(`agent_settled is notification-only with aborted=${aborted}, even with persisted complete batch`, async (t) => {
    const previousNotify = process.env.PI_CONTEXT_GC_NOTIFY;
    process.env.PI_CONTEXT_GC_NOTIFY = "1";
    t.after(() => {
      if (previousNotify === undefined) delete process.env.PI_CONTEXT_GC_NOTIFY;
      else process.env.PI_CONTEXT_GC_NOTIFY = previousNotify;
    });
    const f = harness();
    const notices = [];
    f.ctx.hasUI = true;
    f.ctx.ui.notify = (text) => notices.push(text);
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    const tool = f.tools.get("compact_context");
    await tool.execute("tool-1", input, undefined, undefined, f.ctx);
    f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
    f.ctx.isIdle = () => { throw new Error("notification must not inspect idle state"); };
    const entryCount = f.entries.length;

    await emit(f, "agent_settled", { type: "agent_settled", aborted });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.callbacks.value, undefined);
    assert.equal(f.sent.length, 0);
    assert.equal(f.entries.length, entryCount);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /checkpoint remains pending; compaction has not started/);
    const second = await tool.execute("tool-2", input, undefined, undefined, f.ctx);
    assert.equal(second.details.accepted, false);
    assert.match(second.details.reason, /already pending/);

    // The actionable context path, not settlement, still owns compaction.
    await emit(f, "context", { type: "context", messages: batch("tool-1") });
    assert.ok(f.callbacks.value);
  });
}

async function pauseAtQueuedBoundary(f) {
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  assert.equal((await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx)).details.accepted, true);
  f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
  f.ctx.isIdle = () => false;
  f.ctx.hasPendingMessages = () => true;
  const before = structuredClone(f.entries);
  await emit(f, "context", { type: "context", messages: batch("tool-1") });
  assert.deepEqual(f.entries, before, "active context refusal cannot append a failed diagnostic");
  assert.equal(f.callbacks.value, undefined);
  assert.equal(f.sent.length, 0);
}

for (const aborted of [false, true]) {
  test(`settled idle flushes the queued-boundary diagnostic once without compaction or resume, aborted=${aborted}`, async (t) => {
    const f = harness();
    configure(t, f, { resumeOnFailure: true, notify: true });
    const statuses = [];
    f.ctx.hasUI = true;
    f.ctx.ui.setStatus = (_id, status) => statuses.push(status);
    await pauseAtQueuedBoundary(f);
    assert.equal(statuses.at(-1), "paused");
    await emit(f, "agent_settled", { type: "agent_settled", aborted });
    assert.equal(f.entries.length, 1, "settlement alone is insufficient while busy");
    f.ctx.isIdle = () => true;
    // The queued turn still owns continuation; this hook may only persist diagnostics.
    await emit(f, "agent_settled", { type: "agent_settled", aborted });
    await emit(f, "agent_settled", { type: "agent_settled", aborted });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested", "failed"]);
    assert.match(f.entries.at(-1).data.error, /queued input/);
    assert.deepEqual(f.entries.at(-1).data.checkpoint, f.entries[0].data.checkpoint);
    assert.equal(f.callbacks.value, undefined);
    assert.equal(f.sent.length, 0);
  });
}

for (const idle of [undefined, "true", "throw"]) {
  test(`settled diagnostic refuses unknown idle ${String(idle)}`, async () => {
    const f = harness();
    await pauseAtQueuedBoundary(f);
    f.ctx.isIdle = () => { if (idle === "throw") throw new Error("unknown"); return idle; };
    await emit(f, "agent_settled", { type: "agent_settled", aborted: false });
    assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested"]);
    assert.equal(f.callbacks.value, undefined);
    assert.equal(f.sent.length, 0);
  });
}

for (const obsolete of ["session_before_tree", "session_tree", "session_start", "session_shutdown", "cancel", "session change", "admission"]) {
  test(`${obsolete} discards the paused diagnostic before settlement`, async () => {
    const f = admittedHarness();
    await pauseAtQueuedBoundary(f);
    if (obsolete === "cancel") await f.commands.get("context-gc").handler("cancel", f.ctx);
    else if (obsolete === "session change") f.ctx.sessionManager.getSessionId = () => "session-2";
    else if (obsolete === "admission") f.admission.active = false;
    else await emit(f, obsolete, { type: obsolete, reason: "resume" });
    const before = structuredClone(f.entries);
    f.ctx.isIdle = () => true;
    await emit(f, "agent_settled", { type: "agent_settled", aborted: false });
    f.ctx.sessionManager.getSessionId = () => "session-1";
    f.admission.active = true;
    await emit(f, "agent_settled", { type: "agent_settled", aborted: false });
    assert.deepEqual(f.entries, before);
    assert.equal(f.callbacks.value, undefined);
    assert.equal(f.sent.length, 0);
  });
}

test("complete batch compacts and resumes with the canonical ledger", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const tool = f.tools.get("compact_context");
  await tool.execute("tool-1", input, undefined, undefined, f.ctx);
  f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
  await emit(f, "context", { type: "context", messages: batch("tool-1") });

  assert.ok(f.callbacks.value);
  f.callbacks.value.onComplete({
    summary: "opaque placeholder",
    firstKeptEntryId: "entry-1",
    tokensBefore: 100_000,
    estimatedTokensAfter: 20_000,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.triggerTurn, true);
  assert.equal(f.sent[0].message.display, false);
  assert.match(f.sent[0].message.content, /phase B/);
  assert.match(f.sent[0].message.content, /old hypothesis/);
  assert.match(f.sent[0].message.content, /unit tests pass/);
  assert.match(f.sent[0].message.content, /The semantic phase-boundary compaction completed\./);
});

test("transformed context cannot complete an unpersisted sibling result", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  const supplied = batch("tool-1");
  supplied[0].content.push({ type: "toolCall", id: "sibling", name: "read", arguments: {} });
  f.contextEntries.push(...supplied.map((message) => ({ type: "message", message })));
  const siblingResult = {
    role: "toolResult", toolCallId: "sibling", toolName: "read", isError: false, content: [],
  };
  await emit(f, "context", { type: "context", messages: [...supplied, siblingResult] });
  assert.equal(f.callbacks.value, undefined);
  assert.equal(f.sent.length, 0);

  f.contextEntries.push({ type: "message", message: siblingResult });
  await emit(f, "context", { type: "context", messages: [...supplied, siblingResult] });
  assert.ok(f.callbacks.value);
});

for (const blocked of ["busy", "queued", "inspection failure"]) {
  test(`/context-gc resume does not dispatch while ${blocked}`, async () => {
    const f = harness();
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    if (blocked === "busy") f.ctx.isIdle = () => false;
    else if (blocked === "queued") f.ctx.hasPendingMessages = () => true;
    else f.ctx.hasPendingMessages = () => { throw new Error("inspection unavailable"); };
    await f.commands.get("context-gc").handler("resume", f.ctx);
    assert.equal(f.sent.length, 0);
    assert.equal(f.entries.at(-1).data.status, "requested");
  });
}

for (const blocked of [
  { name: "short context", apply(f) { f.ctx.sdkReadiness = () => ({ ok: true, eligible: false, sessionId: "session-1", leafId: "leaf-1" }); } },
  { name: "missing host", apply(f) { delete f.ctx.sdkReadiness; } },
  { name: "missing SDK settings", apply(f) { delete f.pi.getSettings; } },
  { name: "settings error", apply(f) { f.pi.getSettings = () => { throw new Error("PRIVATE CONTENT"); }; } },
  { name: "malformed host", apply(f) { f.ctx.sdkReadiness = () => ({ ok: true, eligible: "true", sessionId: "session-1", leafId: "leaf-1" }); } },
  { name: "wrong session", apply(f) { f.ctx.sdkReadiness = () => ({ ok: true, eligible: true, sessionId: "other", leafId: "leaf-1" }); } },
]) {
  test(`tool refusal for ${blocked.name} explicitly continues current work`, async () => {
    const f = harness();
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    blocked.apply(f);
    const response = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    assert.equal(response.details.accepted, false);
    assert.match(response.content[0].text, /Continue current work; do not stop this phase/);
    assert.doesNotMatch(response.content[0].text, /PRIVATE CONTENT|Stop this phase now/);
    assert.deepEqual(f.entries, []);
    assert.deepEqual(f.sent, []);
    assert.equal(f.callbacks.value, undefined);
  });
}

for (const blocked of ["short context", "SDK unavailable", "busy", "queued", "incomplete batch", "history error", "Stop"]) {
  test(`/context-gc retry refuses ${blocked} without abort, compact or resume`, async () => {
    const f = harness();
    const notices = [];
    f.ctx.hasUI = true;
    f.ctx.ui.notify = (text) => notices.push(text);
    f.ctx.abort = () => assert.fail("retry must not abort");
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
    await emit(f, "context", { type: "context", messages: batch("tool-1") });
    f.callbacks.value.onError(new Error("backend unavailable"));
    f.callbacks.value = undefined;
    if (blocked === "short context") f.ctx.sdkReadiness = () => ({ ok: true, eligible: false, sessionId: "session-1", leafId: "leaf-1" });
    else if (blocked === "SDK unavailable") delete f.pi.getSettings;
    else if (blocked === "busy") f.ctx.isIdle = () => false;
    else if (blocked === "queued") f.ctx.hasPendingMessages = () => true;
    else if (blocked === "incomplete batch") f.contextEntries.pop();
    else if (blocked === "history error") f.ctx.sessionManager.buildContextEntries = () => { throw new Error("PRIVATE CONTENT"); };
    else f.ctx.signal = AbortSignal.abort();
    notices.length = 0;
    await f.commands.get("context-gc").handler("retry", f.ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.callbacks.value, undefined);
    assert.equal(f.sent.length, 0);
    assert.equal(f.entries.at(-1).data.status, "failed");
    assert.match(notices.at(-1), /compaction paused/);
    assert.doesNotMatch(notices.at(-1), /PRIVATE CONTENT/);
  });
}

test("manual retry accepts an eligible complete persisted checkpoint in an idle unqueued session", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
  await emit(f, "context", { type: "context", messages: batch("tool-1") });
  const first = f.callbacks.value;
  first.onError(new Error("backend unavailable"));
  await f.commands.get("context-gc").handler("retry", f.ctx);
  assert.notEqual(f.callbacks.value, first);
  first.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  assert.equal(f.entries.some((entry) => entry.data.status === "completed"), false);
  f.callbacks.value.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].message.content, /The semantic phase-boundary compaction completed\./);
});

const treeEvents = {
  session_before_tree: {
    type: "session_before_tree",
    preparation: {
      targetId: "leaf-2", oldLeafId: "leaf-1", commonAncestorId: null,
      entriesToSummarize: [], userWantsSummary: false,
    },
    signal: new AbortController().signal,
  },
  session_tree: { type: "session_tree", oldLeafId: "leaf-1", newLeafId: "leaf-2" },
};

async function navigate(f, names) {
  for (const name of names) {
    assert.ok(f.handlers.has(name));
    for (const handler of f.handlers.get(name)) {
      assert.equal(await handler(treeEvents[name], f.ctx), undefined);
    }
  }
}

for (const navigation of [["session_before_tree"], ["session_tree"], ["session_before_tree", "session_tree"]]) {
  const label = navigation.join(" -> ");
  test(`${label} invalidates a pending checkpoint without old manual resume or compaction`, async () => {
    const f = harness();
    f.ctx.abort = () => assert.fail("navigation must not abort");
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    const tool = f.tools.get("compact_context");
    assert.equal((await tool.execute("tool-1", input, undefined, undefined, f.ctx)).details.accepted, true);
    f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
    const entryCount = f.entries.length;

    // Leave session/leaf mocks unchanged: event invalidation itself must suffice,
    // including a before-tree request that another extension might cancel.
    await navigate(f, navigation);
    await f.commands.get("context-gc").handler("resume", f.ctx);
    await f.commands.get("context-gc").handler("retry", f.ctx);
    await emit(f, "context", { type: "context", messages: batch("tool-1") });
    assert.equal(f.callbacks.value, undefined);
    assert.equal(f.sent.length, 0);
    assert.equal(f.entries.length, entryCount);
    assert.equal((await tool.execute("tool-2", input, undefined, undefined, f.ctx)).details.accepted, true);
  });

  for (const outcome of ["onComplete", "onError"]) {
    test(`${label} makes an in-flight ${outcome} callback unable to resume or affect a new checkpoint`, async () => {
      const f = harness();
      f.ctx.abort = () => assert.fail("navigation must not abort");
      await emit(f, "session_start", { type: "session_start", reason: "startup" });
      const tool = f.tools.get("compact_context");
      await tool.execute("tool-1", input, undefined, undefined, f.ctx);
      f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
      await emit(f, "context", { type: "context", messages: batch("tool-1") });
      const stale = f.callbacks.value;
      assert.ok(stale);
      const entryCount = f.entries.length;

      await navigate(f, navigation);
      await f.commands.get("context-gc").handler("resume", f.ctx);
      assert.equal(f.entries.length, entryCount);
      const fresh = await tool.execute("tool-2", input, undefined, undefined, f.ctx);
      assert.equal(fresh.details.accepted, true);
      if (outcome === "onComplete") stale.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
      else stale.onError(new Error("stale compaction failure"));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(f.callbacks.value, stale); // Navigation never requested another compaction.
      assert.equal(f.sent.length, 0);
      assert.equal(f.entries.length, entryCount + 1);
      assert.equal(f.entries.at(-1).data.checkpoint.id, fresh.details.checkpointId);
      assert.equal(f.entries.at(-1).data.status, "requested");
      const duplicate = await tool.execute("tool-3", input, undefined, undefined, f.ctx);
      assert.equal(duplicate.details.accepted, false);
      assert.match(duplicate.details.reason, /already pending/);
    });
  }

  test(`${label} cancels a completed checkpoint's already deferred automatic continuation`, async () => {
    const f = harness();
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
    await emit(f, "context", { type: "context", messages: batch("tool-1") });
    f.callbacks.value.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
    const entryCount = f.entries.length;
    await navigate(f, navigation);
    await new Promise((resolve) => setImmediate(resolve));
    await f.commands.get("context-gc").handler("resume", f.ctx);
    assert.equal(f.sent.length, 0);
    assert.equal(f.entries.length, entryCount);
    assert.equal(f.entries.at(-1).data.status, "completed");
  });
}

function admittedHarness() {
  const state = { active: true, admit: true, event: undefined };
  const f = harness({
    admitSession(event) { state.event = event; return state.admit; },
    isActive() { return state.active; },
  });
  return { ...f, admission: state };
}

test("optional admission starts hidden, receives the actual start event, and reuses the base declaration", async () => {
  const f = admittedHarness();
  const initial = f.tools.get("compact_context");
  assert.equal(initial.exposure, "hidden");
  assert.equal((await initial.execute("before-start", input, undefined, undefined, f.ctx)).details.reason, "inactive");
  const event = { type: "session_start", reason: "new", previousSessionFile: "previous.jsonl" };
  await emit(f, "session_start", event);
  assert.equal(f.admission.event, event);
  const active = f.tools.get("compact_context");
  assert.equal(active.exposure, "model-only");
  assert.equal(active.execute, initial.execute);
  assert.equal(active.parameters, initial.parameters);
  assert.equal(active.executionMode, "sequential");
  assert.deepEqual(active.promptGuidelines, initial.promptGuidelines);
  assert.equal((await active.execute("tool-1", input, undefined, undefined, f.ctx)).details.accepted, true);
});

for (const refusal of ["false", "throw", "nonboolean"]) {
  test(`session admission ${refusal} stays hidden and writes no ledger`, async () => {
    const f = harness({
      admitSession() {
        if (refusal === "throw") throw new Error("PRIVATE CONTENT");
        return refusal === "nonboolean" ? "true" : false;
      },
      isActive() { return true; },
    });
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    assert.equal(f.tools.get("compact_context").exposure, "hidden");
    const result = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    assert.equal(result.details.accepted, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE CONTENT/);
    for (const command of ["status", "retry", "resume", "cancel"]) await f.commands.get("context-gc").handler(command, f.ctx);
    await emit(f, "context", { type: "context", messages: batch("tool-1") });
    assert.equal(f.entries.length, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.callbacks.value, undefined);
  });
}

for (const event of ["context", "input", "agent_settled", "model_select", "session_tree"]) {
  test(`live admission refusal at ${event} hides and invalidates old checkpoint without ledger writes`, async () => {
    const f = admittedHarness();
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    const count = f.entries.length;
    f.admission.active = false;
    await emit(f, event, { type: event, messages: batch("tool-1"), source: "interactive" });
    assert.equal(f.tools.get("compact_context").exposure, "hidden");
    for (const command of ["status", "retry", "resume", "cancel"]) await f.commands.get("context-gc").handler(command, f.ctx);
    assert.equal((await f.tools.get("compact_context").execute("tool-2", input, undefined, undefined, f.ctx)).details.reason, "inactive");
    f.admission.active = true;
    await f.commands.get("context-gc").handler("resume", f.ctx);
    assert.equal(f.entries.length, count);
    assert.equal(f.sent.length, 0);
    assert.equal(f.callbacks.value, undefined);
  });
}

for (const stage of ["onComplete", "onError", "deferred"]) {
  test(`live refusal guards ${stage} even without an intervening lifecycle event`, async () => {
    const f = admittedHarness();
    await emit(f, "session_start", { type: "session_start", reason: "startup" });
    await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
    f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
    await emit(f, "context", { type: "context", messages: batch("tool-1") });
    assert.ok(f.callbacks.value);
    if (stage === "deferred") f.callbacks.value.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
    const count = f.entries.length;
    f.admission.active = false;
    if (stage === "onComplete") f.callbacks.value.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
    if (stage === "onError") f.callbacks.value.onError(new Error("PRIVATE CONTENT"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.tools.get("compact_context").exposure, "hidden");
    assert.equal(f.entries.length, count);
    assert.equal(f.sent.length, 0);
  });
}

test("admitted compaction preserves nonenumerable injected readiness, all ledgers and one deferred resume", async () => {
  const f = admittedHarness();
  Object.defineProperty(f.ctx, "sdkReadiness", {
    value: f.ctx.sdkReadiness, enumerable: false, configurable: false, writable: false,
  });
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  f.contextEntries.push(...batch("tool-1").map((message) => ({ type: "message", message })));
  await emit(f, "context", { type: "context", messages: batch("tool-1") });
  assert.ok(f.callbacks.value);
  f.callbacks.value.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  f.callbacks.value.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested", "completed", "resumed"]);
  assert.match(f.sent[0].message.content, /phase B/);
  assert.match(f.sent[0].message.content, /old hypothesis/);
  assert.match(f.sent[0].message.content, /unit tests pass/);
});

test("admitted model switch and shutdown invalidate even if the callback would still allow work", async () => {
  const f = admittedHarness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  await emit(f, "model_select", { type: "model_select" });
  await f.commands.get("context-gc").handler("resume", f.ctx);
  assert.equal(f.sent.length, 0);
  assert.equal(f.entries.length, 1);
  await emit(f, "session_shutdown", { type: "session_shutdown", reason: "reload" });
  assert.equal(f.tools.get("compact_context").exposure, "hidden");
  assert.equal((await f.tools.get("compact_context").execute("tool-2", input, undefined, undefined, f.ctx)).details.reason, "inactive");
  assert.equal(f.entries.length, 1);
});

test("a throwing live callback fails closed and does not disclose its error", async () => {
  let throws = false;
  const f = harness({
    admitSession: () => true,
    isActive() { if (throws) throw new Error("PRIVATE CONTENT"); return true; },
  });
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  throws = true;
  const result = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  assert.equal(result.details.reason, "inactive");
  assert.equal(f.tools.get("compact_context").exposure, "hidden");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE CONTENT/);
  assert.equal(f.entries.length, 0);
});
