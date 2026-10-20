import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelPending,
  createRuntimeState,
  flushPendingPauseDiagnostic,
  invalidateRuntime,
  resetRuntime,
  formatRuntimeStatus,
  maybeStartAtContextBoundary,
  resumeWithoutCompaction,
  resumeCheckpoint,
  scheduleCheckpoint,
  startCompaction,
} from "./readiness-fixture.mjs";

const config = {
  enabled: true,
  autoResume: true,
  resumeOnFailure: false,
  notify: false,
  minContextTokens: 0,
};

function assistant(toolCallId) {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: toolCallId,
      name: "compact_context",
      arguments: {},
    }],
  };
}

function result(toolCallId) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "compact_context",
    isError: false,
    content: [{ type: "text", text: "queued" }],
  };
}

function fixture({ idle = true, pendingMessages = false } = {}) {
  const entries = [];
  const messages = [];
  const contextEntries = [];
  const calls = { compact: 0, send: 0, abort: 0 };
  let compactCallbacks;
  const pi = {
    getSettings: () => ({ compaction: { keepRecentTokens: 20_000 } }),
    appendEntry(type, data) { entries.push({ type, data }); },
    sendMessage(message, options) {
      calls.send += 1;
      messages.push({ message, options });
    },
  };
  const ctx = {
    cwd: "/tmp",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "session-1",
      getLeafId: () => "leaf-1",
      buildContextEntries: () => contextEntries,
    },
    sdkReadiness: () => ({ ok: true, eligible: true, sessionId: "session-1", leafId: "leaf-1" }),
    abort() { calls.abort += 1; },
    getContextUsage: () => ({ tokens: 100_000, contextWindow: 350_000, percent: 28.57 }),
    compact(options) {
      calls.compact += 1;
      compactCallbacks = options;
    },
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
  };
  return {
    pi,
    ctx,
    entries,
    messages,
    contextEntries,
    calls,
    get callbacks() { return compactCallbacks; },
  };
}

const input = {
  completed_phase: "phase A",
  next_focus: "phase B",
  keep: ["decision 1"],
  ruled_out: ["old path"],
  verification: ["phase A acceptance criteria pass"],
};

const floorConfig = { ...config, minContextTokens: 150_000 };
const invalidUsages = [
  { name: "missing usage", read: () => undefined },
  { name: "null usage", read: () => null },
  { name: "missing tokens", read: () => ({}) },
  { name: "null tokens", read: () => ({ tokens: null }) },
  { name: "throw", read: () => { throw new Error("PRIVATE USAGE"); } },
  ...[NaN, Infinity, -Infinity, -1, "150000", true, {}].map((tokens) => ({
    name: `invalid tokens ${String(tokens)}`, read: () => ({ tokens }),
  })),
];

for (const usage of [{ name: "149999", read: () => ({ tokens: 149_999 }) }, ...invalidUsages]) {
  test(`positive minimum refuses ${usage.name} without runtime, ledger or action mutations`, () => {
    const f = fixture();
    const runtime = createRuntimeState();
    // A prior success/error must not be erased by a refused request.
    runtime.lastCompletedCheckpointId = "previous";
    runtime.lastError = "previous diagnostic";
    const before = structuredClone(runtime);
    f.ctx.getContextUsage = usage.read;
    const response = scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input, floorConfig);
    assert.equal(response.ok, false);
    assert.match(response.reason, /at least 150000 context tokens/);
    assert.match(response.reason, usage.name === "149999" ? /149999/ : /unknown/);
    assert.doesNotMatch(response.reason, /PRIVATE USAGE/);
    assert.deepEqual(runtime, before);
    assert.deepEqual(f.entries, []);
    assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
  });
}

for (const tokens of [150_000, 150_001]) {
  test(`current usage ${tokens} satisfies the minimum with exact SDK eligibility`, () => {
    const f = fixture();
    const runtime = createRuntimeState();
    let usageReads = 0;
    f.ctx.getContextUsage = () => { usageReads += 1; return { tokens, contextWindow: 350_000 }; };
    const response = scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input, floorConfig);
    assert.equal(response.ok, true);
    assert.equal(response.checkpoint.tokensAtRequest, tokens);
    assert.equal(usageReads, 1);
    assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested"]);
    assert.equal(startCompaction(f.pi, f.ctx, runtime, floorConfig), true);
    assert.equal(usageReads, 2);
    assert.equal(f.calls.compact, 1);
  });
}

for (const explicit of [false, true]) {
  test(`minimum zero preserves unknown-usage scheduling and start (explicit config=${explicit})`, () => {
    const f = fixture();
    const runtime = createRuntimeState();
    f.ctx.getContextUsage = () => { throw new Error("usage unavailable"); };
    const response = explicit
      ? scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input, config)
      : scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
    assert.equal(response.ok, true);
    assert.equal(response.checkpoint.tokensAtRequest, undefined);
    assert.equal(startCompaction(f.pi, f.ctx, runtime, config), true);
    assert.equal(f.calls.compact, 1);
    delete f.ctx.sdkReadiness;
    const other = createRuntimeState();
    assert.equal(scheduleCheckpoint(f.pi, f.ctx, other, "tool-2", input, config).ok, false);
    assert.deepEqual(other, createRuntimeState());
  });
}

for (const stage of ["persisted boundary", "retry"]) {
  for (const usage of [{ name: "149999", read: () => ({ tokens: 149_999 }) }, ...invalidUsages]) {
    test(`${stage} rereads ${usage.name}, pauses and prevents automatic failure fallback`, async () => {
      const f = fixture();
      const runtime = createRuntimeState();
      const fallbackConfig = { ...floorConfig, resumeOnFailure: true };
      f.ctx.getContextUsage = () => ({ tokens: 150_000 });
      assert.equal(scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input, fallbackConfig).ok, true);
      f.contextEntries.push(...[assistant("tool-1"), result("tool-1")]
        .map((message) => ({ type: "message", message })));
      const checkpoint = runtime.checkpoint;
      if (stage === "retry") {
        assert.equal(startCompaction(f.pi, f.ctx, runtime, fallbackConfig), true);
        f.callbacks.onError(new Error("backend unavailable"));
      }
      f.ctx.getContextUsage = usage.read;
      const started = stage === "retry"
        ? startCompaction(f.pi, f.ctx, runtime, fallbackConfig)
        : maybeStartAtContextBoundary(f.pi, f.ctx, runtime, fallbackConfig, [assistant("tool-1"), result("tool-1")]);
      assert.equal(started, false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runtime.phase, "failed");
      assert.equal(runtime.checkpoint, checkpoint);
      assert.equal(runtime.checkpoint.tokensAtRequest, 150_000);
      assert.match(runtime.lastError, /at least 150000 context tokens/);
      assert.match(runtime.lastError, usage.name === "149999" ? /149999/ : /unknown/);
      assert.doesNotMatch(runtime.lastError, /PRIVATE USAGE/);
      assert.deepEqual(f.calls, { compact: stage === "retry" ? 1 : 0, send: 0, abort: 0 });
      if (stage === "persisted boundary") {
        assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested"], "context pause must not append, even when the idle getter returns true");
        flushPendingPauseDiagnostic(f.pi, f.ctx, runtime);
      }
      assert.equal(f.entries.at(-1).data.status, "failed");
      assert.equal(f.entries.some((entry) => ["completed", "resumed"].includes(entry.data.status)), false);
    });
  }
}

test("positive minimum retains complete persisted batch and single-resume behavior", async () => {
  const f = fixture();
  const runtime = createRuntimeState();
  f.ctx.getContextUsage = () => ({ tokens: 150_000 });
  assert.equal(scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input, floorConfig).ok, true);
  assert.equal(maybeStartAtContextBoundary(f.pi, f.ctx, runtime, floorConfig, [assistant("tool-1"), result("tool-1")]), false);
  f.contextEntries.push(...[assistant("tool-1"), result("tool-1")].map((message) => ({ type: "message", message })));
  assert.equal(maybeStartAtContextBoundary(f.pi, f.ctx, runtime, floorConfig, [assistant("tool-1"), result("tool-1")]), true);
  f.callbacks.onComplete({ tokensBefore: 150_000, estimatedTokensAfter: 20_000 });
  f.callbacks.onComplete({ tokensBefore: 150_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, { compact: 1, send: 1, abort: 0 });
  assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested", "completed", "resumed"]);
});

test("runtime status displays the effective minimum, not readiness", () => {
  assert.match(formatRuntimeStatus(createRuntimeState(), floorConfig), /minimum context tokens: 150000/);
  assert.match(formatRuntimeStatus(createRuntimeState(), config), /minimum context tokens: 0/);
  assert.doesNotMatch(formatRuntimeStatus(createRuntimeState(), floorConfig), /ready|eligible/);
});

test("schedules once and rejects a second pending checkpoint", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  const first = scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  assert.equal(first.ok, true);
  assert.equal(runtime.phase, "pending");
  const second = scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-2", input);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already pending/);
});

test("starts only at the complete batch containing the exact checkpoint call", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);

  assert.equal(
    maybeStartAtContextBoundary(f.pi, f.ctx, runtime, config, [assistant("other"), result("other")]),
    false,
  );
  assert.equal(f.calls.compact, 0);

  f.contextEntries.push(
    ...[assistant("tool-1"), result("tool-1")].map((message) => ({ type: "message", message })),
  );
  assert.equal(
    maybeStartAtContextBoundary(f.pi, f.ctx, runtime, config, [assistant("tool-1"), result("tool-1")]),
    true,
  );
  assert.equal(f.calls.compact, 1);
  assert.deepEqual(Object.keys(f.callbacks).sort(), ["customInstructions", "onComplete", "onError"]);
  assert.equal(runtime.phase, "compacting");
  assert.match(f.callbacks.customInstructions, /phase A/);
  assert.match(f.callbacks.customInstructions, /phase B/);
});

test("successful compaction resumes exactly once when Pi is idle", async () => {
  const f = fixture({ idle: true });
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);

  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.calls.send, 1);
  assert.equal(runtime.phase, "idle");
  assert.match(f.messages[0].message.content, /phase B/);
  assert.match(f.messages[0].message.content, /The semantic phase-boundary compaction completed\./);
  assert.equal(f.entries.filter((entry) => entry.data.status === "completed").length, 1);
  assert.equal(f.entries.filter((entry) => entry.data.status === "resumed").length, 1);
  assert.equal(resumeCheckpoint(f.pi, f.ctx, runtime, config, "duplicate"), false);
});


test("autoResume false keeps the completed checkpoint resumable", async () => {
  const f = fixture({ idle: true });
  const runtime = createRuntimeState();
  const manualConfig = { ...config, autoResume: false };
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, manualConfig);

  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.calls.send, 0);
  assert.equal(runtime.phase, "resume-pending");
  assert.equal(resumeWithoutCompaction(
    f.pi,
    f.ctx,
    runtime,
    manualConfig,
    "manual continuation after completed compaction",
  ), true);
  assert.equal(f.calls.send, 1);
  assert.match(f.messages[0].message.content, /old path/);
  assert.match(f.messages[0].message.content, /The semantic phase-boundary compaction completed\./);
});

test("successful compaction does not create a second turn when Pi is not idle", async () => {
  const f = fixture({ idle: false });
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.send, 0);
  assert.equal(runtime.phase, "idle");
});

test("failure pauses by default and explicit resume continues without compaction", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  f.callbacks.onError(new Error("remote unavailable"));

  assert.equal(runtime.phase, "failed");
  assert.equal(f.calls.send, 0);
  assert.equal(resumeWithoutCompaction(f.pi, f.ctx, runtime, config, "test recovery"), true);
  assert.equal(f.calls.send, 1);
  assert.equal(runtime.phase, "idle");
  assert.match(f.messages[0].message.content, /old path/);
  assert.match(f.messages[0].message.content, /No successful compaction has completed for this checkpoint/);
  assert.doesNotMatch(f.messages[0].message.content, /The semantic phase-boundary compaction completed\./);
});

test("stale session prevents compaction", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  const before = structuredClone(f.entries);
  f.ctx.sessionManager.getSessionId = () => "session-2";
  assert.equal(startCompaction(f.pi, f.ctx, runtime, config), false);
  assert.equal(f.calls.compact, 0);
  assert.equal(runtime.phase, "failed");
  assert.deepEqual(f.entries, before, "Never append the old checkpoint ledger into a different active session");
});

for (const persisted of [
  { name: "empty history", messages: [] },
  { name: "missing result", messages: [assistant("tool-1")] },
  { name: "another complete batch", messages: [assistant("other"), result("other")] },
  {
    name: "incomplete sibling results",
    messages: [{
      role: "assistant",
      content: [...assistant("tool-1").content, ...assistant("sibling").content],
    }, result("tool-1")],
  },
  { name: "duplicate result", messages: [assistant("tool-1"), result("tool-1"), result("tool-1")] },
]) {
  test(`transformed complete context cannot forge persisted ${persisted.name}`, () => {
    const f = fixture();
    const runtime = createRuntimeState();
    scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
    f.contextEntries.push(...persisted.messages.map((message) => ({ type: "message", message })));
    assert.equal(maybeStartAtContextBoundary(
      f.pi, f.ctx, runtime, config, [assistant("tool-1"), result("tool-1")],
    ), false);
    assert.equal(f.calls.compact, 0);
    assert.equal(runtime.phase, "pending");
  });
}

for (const suppliedSibling of ["sibling-A", "sibling-B"]) {
  test(`complete context/persisted sibling sets must agree: ${suppliedSibling}`, () => {
    const f = fixture();
    const runtime = createRuntimeState();
    scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
    const completeBatch = (sibling) => [{
      role: "assistant",
      content: [...assistant("tool-1").content, ...assistant(sibling).content],
    }, result("tool-1"), result(sibling)];
    f.contextEntries.push(...completeBatch("sibling-A").map((message) => ({ type: "message", message })));
    const expectedStart = suppliedSibling === "sibling-A";
    assert.equal(maybeStartAtContextBoundary(
      f.pi, f.ctx, runtime, config, completeBatch(suppliedSibling),
    ), expectedStart);
    assert.equal(f.calls.compact, expectedStart ? 1 : 0);
    assert.equal(runtime.phase, expectedStart ? "compacting" : "pending");
  });
}

test("persisted complete batch does not authorize incomplete supplied context", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  f.contextEntries.push(...[assistant("tool-1"), result("tool-1")]
    .map((message) => ({ type: "message", message })));
  assert.equal(maybeStartAtContextBoundary(f.pi, f.ctx, runtime, config, [assistant("tool-1")]), false);
  assert.equal(f.calls.compact, 0);
  assert.equal(runtime.phase, "pending");
});

test("persisted batch inspection failure leaves checkpoint pending", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  f.ctx.sessionManager.buildContextEntries = () => { throw new Error("history unavailable"); };
  assert.equal(maybeStartAtContextBoundary(
    f.pi, f.ctx, runtime, config, [assistant("tool-1"), result("tool-1")],
  ), false);
  assert.equal(f.calls.compact, 0);
  assert.equal(runtime.phase, "pending");
});

test("pending resume retains every ledger without claiming successful compaction", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  const pendingInput = { ...input, open_loops: ["remaining check"] };
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", pendingInput);
  assert.equal(resumeCheckpoint(f.pi, f.ctx, runtime, config, "manual pending resume"), true);
  assert.equal(f.calls.compact, 0);
  assert.equal(f.calls.send, 1);
  const text = f.messages[0].message.content;
  assert.match(text, /No successful compaction has completed for this checkpoint/);
  for (const value of [pendingInput.completed_phase, pendingInput.next_focus,
    ...pendingInput.keep, ...pendingInput.open_loops, ...pendingInput.ruled_out, ...pendingInput.verification]) {
    assert.ok(text.includes(value));
  }
  assert.equal(runtime.phase, "idle");
});

const blockedContinuationStates = [
  { name: "busy", apply(f) { f.ctx.isIdle = () => false; } },
  { name: "queued input", apply(f) { f.ctx.hasPendingMessages = () => true; } },
  { name: "idle inspection throws", apply(f) { f.ctx.isIdle = () => { throw new Error("idle unavailable"); }; } },
  { name: "queue inspection throws", apply(f) { f.ctx.hasPendingMessages = () => { throw new Error("queue unavailable"); }; } },
  { name: "different session", apply(f) { f.ctx.sessionManager.getSessionId = () => "session-2"; } },
  { name: "session inspection throws", apply(f) { f.ctx.sessionManager.getSessionId = () => { throw new Error("session unavailable"); }; } },
];

for (const phase of ["pending", "failed", "resume-pending"]) {
  for (const blocked of blockedContinuationStates) {
    test(`manual ${phase} resume fails closed with ${blocked.name}`, async () => {
      const f = fixture();
      const runtime = createRuntimeState();
      const manualConfig = { ...config, autoResume: false };
      scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
      if (phase !== "pending") {
        startCompaction(f.pi, f.ctx, runtime, manualConfig);
        if (phase === "failed") f.callbacks.onError(new Error("compaction failed"));
        else f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
        await new Promise((resolve) => setImmediate(resolve));
      }
      const checkpoint = runtime.checkpoint;
      blocked.apply(f);
      assert.equal(resumeCheckpoint(f.pi, f.ctx, runtime, manualConfig, "manual recovery"), false);
      assert.equal(f.calls.send, 0);
      assert.equal(runtime.phase, phase);
      assert.equal(runtime.checkpoint, checkpoint);
      assert.equal(f.entries.some((entry) => entry.data.status === "resumed"), false);
    });
  }
}

test("queued input owns successful continuation without an extra resume", async () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  // Input arriving during compaction, not before admission, owns continuation.
  f.ctx.hasPendingMessages = () => true;
  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.send, 0);
  assert.equal(runtime.phase, "idle");
  assert.equal(runtime.checkpoint, undefined);
  assert.equal(f.entries.at(-1).data.status, "continued-by-existing-turn");
  assert.equal(f.entries.at(-1).data.hasPendingMessages, true);
});

for (const method of ["isIdle", "hasPendingMessages"]) {
  test(`automatic success fails closed when ${method} throws`, async () => {
    const f = fixture();
    const runtime = createRuntimeState();
    scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
    startCompaction(f.pi, f.ctx, runtime, config);
    f.ctx[method] = () => { throw new Error("inspection unavailable"); };
    f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.send, 0);
    assert.equal(runtime.phase, "failed");
    assert.match(runtime.lastError, /unable to inspect continuation/);
    assert.ok(runtime.checkpoint);
    assert.equal(f.entries.some((entry) => entry.data.status === "continued-by-existing-turn"), false);
  });
}

for (const blocked of blockedContinuationStates) {
  test(`automatic failure fallback does not resume with ${blocked.name}`, async () => {
    const f = fixture();
    const runtime = createRuntimeState();
    const fallbackConfig = { ...config, resumeOnFailure: true };
    scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
    startCompaction(f.pi, f.ctx, runtime, fallbackConfig);
    f.callbacks.onError(new Error("remote unavailable"));
    blocked.apply(f);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.send, 0);
    assert.equal(runtime.phase, "failed");
    assert.ok(runtime.checkpoint);
  });
}

test("automatic failure fallback sends one truthful canonical checkpoint when idle", async () => {
  const f = fixture();
  const runtime = createRuntimeState();
  const fallbackConfig = { ...config, resumeOnFailure: true };
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, fallbackConfig);
  f.callbacks.onError(new Error("remote unavailable"));
  f.callbacks.onError(new Error("duplicate"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.send, 1);
  assert.equal(runtime.phase, "idle");
  assert.match(f.messages[0].message.content, /No successful compaction has completed for this checkpoint/);
  assert.match(f.messages[0].message.content, /old path/);
  assert.match(f.messages[0].message.content, /phase A acceptance criteria pass/);
});

test("a previous checkpoint's success cannot label the next pending resume as compacted", async () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.send, 1);
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-2", input);
  assert.notEqual(runtime.lastCompletedCheckpointId, runtime.checkpoint.id);
  assert.equal(resumeCheckpoint(f.pi, f.ctx, runtime, config, "pending recovery"), true);
  assert.equal(f.calls.send, 2);
  assert.match(f.messages[1].message.content, /No successful compaction has completed for this checkpoint/);
});

const blockedEligibility = [
  { name: "short boundary", apply(f) { f.ctx.sdkReadiness = () => ({ ok: true, eligible: false, sessionId: "session-1", leafId: "leaf-1" }); } },
  { name: "SDK settings unavailable", apply(f) { delete f.pi.getSettings; } },
  { name: "host missing", apply(f) { delete f.ctx.sdkReadiness; } },
  { name: "host error", apply(f) { f.ctx.sdkReadiness = () => { throw new Error("PRIVATE CONTENT"); }; } },
  { name: "settings error", apply(f) { f.pi.getSettings = () => { throw new Error("PRIVATE CONTENT"); }; } },
  { name: "settings malformed", apply(f) { f.pi.getSettings = () => null; } },
  { name: "host unavailable", apply(f) { f.ctx.sdkReadiness = () => ({ ok: false, reason: "PRIVATE CONTENT" }); } },
  { name: "host malformed", apply(f) { f.ctx.sdkReadiness = () => ({ ok: true, eligible: 1, sessionId: "session-1", leafId: "leaf-1" }); } },
  { name: "wrong session", apply(f) { f.ctx.sdkReadiness = () => ({ ok: true, eligible: true, sessionId: "other", leafId: "leaf-1" }); } },
  { name: "stale leaf", apply(f) { f.ctx.sdkReadiness = () => ({ ok: true, eligible: true, sessionId: "session-1", leafId: "other" }); } },
];

for (const blocked of blockedEligibility) {
  test(`above-minimum usage does not bypass ${blocked.name}`, () => {
    const f = fixture();
    const runtime = createRuntimeState();
    f.ctx.getContextUsage = () => ({ tokens: 150_001 });
    blocked.apply(f);
    const response = scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input, floorConfig);
    assert.equal(response.ok, false);
    assert.doesNotMatch(response.reason, /PRIVATE CONTENT/);
    assert.deepEqual(runtime, createRuntimeState());
    assert.deepEqual(f.entries, []);
    assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
  });

  test(`schedule refuses ${blocked.name} before recording or stopping anything`, () => {
    const f = fixture();
    const runtime = createRuntimeState();
    blocked.apply(f);
    const response = scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
    assert.equal(response.ok, false);
    assert.doesNotMatch(response.reason, /PRIVATE CONTENT/);
    assert.deepEqual(runtime, createRuntimeState());
    assert.deepEqual(f.entries, []);
    assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
  });

  test(`eligible admission then ${blocked.name} pauses without compaction or failure fallback`, async () => {
    const f = fixture();
    const notices = [];
    f.ctx.hasUI = true;
    f.ctx.ui = { notify: (text) => notices.push(text), setStatus() {} };
    const runtime = createRuntimeState();
    assert.equal(scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input).ok, true);
    f.contextEntries.push(...[assistant("tool-1"), result("tool-1")].map((message) => ({ type: "message", message })));
    blocked.apply(f);
    assert.equal(maybeStartAtContextBoundary(f.pi, f.ctx, runtime, { ...config, resumeOnFailure: true },
      [assistant("tool-1"), result("tool-1")]), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.phase, "failed");
    assert.ok(runtime.lastError);
    assert.doesNotMatch(runtime.lastError, /PRIVATE CONTENT/);
    assert.equal(runtime.lastCompletedCheckpointId, undefined);
    assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
    assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested"], "context refusal defers only the diagnostic");
    flushPendingPauseDiagnostic(f.pi, f.ctx, runtime);
    assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested", "failed"]);
    assert.equal(notices.length, 1); // Forced even when config.notify is false.
    assert.match(notices[0], /compaction paused/);
  });
}

for (const blocked of [
  { name: "queued user input", apply(f) { f.ctx.hasPendingMessages = () => true; } },
  { name: "Stop", apply(f) { f.ctx.signal = AbortSignal.abort(); } },
  { name: "queue inspection failure", apply(f) { f.ctx.hasPendingMessages = () => { throw new Error("PRIVATE CONTENT"); }; } },
  { name: "malformed queue state", apply(f) { f.ctx.hasPendingMessages = () => undefined; } },
]) {
  test(`initial start refuses ${blocked.name} without requiring idle`, async () => {
    const f = fixture({ idle: false });
    const runtime = createRuntimeState();
    scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
    blocked.apply(f);
    assert.equal(startCompaction(f.pi, f.ctx, runtime, { ...config, resumeOnFailure: true }), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.phase, "failed");
    assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
    assert.doesNotMatch(runtime.lastError, /PRIVATE CONTENT/);
  });
}

function pausedFixture() {
  const f = fixture({ idle: false });
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  f.contextEntries.push(...[assistant("tool-1"), result("tool-1")].map((message) => ({ type: "message", message })));
  f.ctx.hasPendingMessages = () => true;
  assert.equal(maybeStartAtContextBoundary(f.pi, f.ctx, runtime, { ...config, resumeOnFailure: true },
    [assistant("tool-1"), result("tool-1")]), false);
  assert.equal(runtime.phase, "failed");
  assert.match(runtime.lastError, /queued input/);
  assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested"]);
  return { ...f, runtime };
}

test("active pause updates state immediately and idle flush records once without starting work", async () => {
  const f = pausedFixture();
  const before = structuredClone(f.runtime);
  flushPendingPauseDiagnostic(f.pi, f.ctx, f.runtime);
  assert.deepEqual(f.runtime, before);
  f.ctx.isIdle = () => true;
  flushPendingPauseDiagnostic(f.pi, f.ctx, f.runtime);
  flushPendingPauseDiagnostic(f.pi, f.ctx, f.runtime);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested", "failed"]);
  assert.equal(f.entries.at(-1).data.error, before.lastError);
  assert.deepEqual(f.entries.at(-1).data.checkpoint, before.checkpoint);
  assert.equal(f.runtime.phase, "failed");
  assert.equal(f.runtime.pendingPauseDiagnostic, undefined);
  assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
});

for (const idle of [undefined, null, 1, "true", "throw"]) {
  test(`pause diagnostic refuses unknown idle ${String(idle)}`, () => {
    const f = pausedFixture();
    f.ctx.isIdle = () => { if (idle === "throw") throw new Error("unknown"); return idle; };
    flushPendingPauseDiagnostic(f.pi, f.ctx, f.runtime);
    assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested"]);
    assert.ok(f.runtime.pendingPauseDiagnostic);
    // A manual retry refusal also cannot append with unknown idle.
    startCompaction(f.pi, f.ctx, f.runtime, config);
    assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested"]);
    assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
  });
}

for (const obsolete of ["generation", "reset", "invalidate", "cancel", "session", "unknown session"]) {
  test(`obsolete ${obsolete} discards a pending pause diagnostic`, () => {
    const f = pausedFixture();
    f.ctx.isIdle = () => true;
    if (obsolete === "generation") f.runtime.generation++;
    else if (obsolete === "reset") resetRuntime(f.runtime);
    else if (obsolete === "invalidate") invalidateRuntime(f.runtime);
    else if (obsolete === "cancel") cancelPending(f.pi, f.ctx, f.runtime, config, "cancel");
    else f.ctx.sessionManager.getSessionId = () => {
      if (obsolete === "unknown session") throw new Error("unknown");
      return "session-2";
    };
    const before = structuredClone(f.entries);
    flushPendingPauseDiagnostic(f.pi, f.ctx, f.runtime);
    assert.equal(f.runtime.pendingPauseDiagnostic, undefined);
    f.ctx.sessionManager.getSessionId = () => "session-1";
    flushPendingPauseDiagnostic(f.pi, f.ctx, f.runtime);
    assert.deepEqual(f.entries, before);
    assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
  });
}

test("idle manual retry refusal records its current diagnostic immediately and only once", () => {
  const f = pausedFixture();
  f.ctx.isIdle = () => true;
  assert.equal(startCompaction(f.pi, f.ctx, f.runtime, config), false);
  assert.deepEqual(f.entries.map((entry) => entry.data.status), ["requested", "failed"]);
  assert.match(f.entries.at(-1).data.error, /queued input/);
  assert.equal(f.runtime.pendingPauseDiagnostic, undefined);
  flushPendingPauseDiagnostic(f.pi, f.ctx, f.runtime);
  assert.equal(f.entries.length, 2);
  assert.deepEqual(f.calls, { compact: 0, send: 0, abort: 0 });
});

function failedFixture(fallback = false) {
  const f = fixture();
  const runtime = createRuntimeState();
  const retryConfig = { ...config, resumeOnFailure: fallback };
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, retryConfig);
  f.callbacks.onError(new Error("backend unavailable"));
  f.contextEntries.push(...[assistant("tool-1"), result("tool-1")].map((message) => ({ type: "message", message })));
  return { ...f, runtime, retryConfig };
}

const blockedRetries = [
  ...blockedEligibility,
  { name: "busy agent", apply(f) { f.ctx.isIdle = () => false; } },
  { name: "malformed idle state", apply(f) { f.ctx.isIdle = () => undefined; } },
  { name: "queued input", apply(f) { f.ctx.hasPendingMessages = () => true; } },
  { name: "Stop", apply(f) { f.ctx.signal = AbortSignal.abort(); } },
  { name: "idle inspection error", apply(f) { f.ctx.isIdle = () => { throw new Error("PRIVATE CONTENT"); }; } },
  { name: "queue inspection error", apply(f) { f.ctx.hasPendingMessages = () => { throw new Error("PRIVATE CONTENT"); }; } },
  { name: "history inspection error", apply(f) { f.ctx.sessionManager.buildContextEntries = () => { throw new Error("PRIVATE CONTENT"); }; } },
  { name: "empty persisted batch", apply(f) { f.contextEntries.length = 0; } },
  { name: "incomplete persisted checkpoint", apply(f) { f.contextEntries.pop(); } },
  { name: "another persisted batch", apply(f) { f.contextEntries.splice(0, 2, ...[assistant("other"), result("other")].map((message) => ({ type: "message", message }))); } },
  { name: "incomplete persisted sibling", apply(f) { f.contextEntries[0].message.content.push(...assistant("sibling").content); } },
  { name: "duplicate persisted result", apply(f) { f.contextEntries.push({ type: "message", message: result("tool-1") }); } },
  { name: "new user message after persisted batch", apply(f) { f.contextEntries.push({ type: "message", message: { role: "user", content: "new work" } }); } },
];
for (const blocked of blockedRetries) {
  test(`failed retry refuses ${blocked.name} and invalidates any already queued failure fallback`, async () => {
    const f = failedFixture(true);
    const checkpoint = f.runtime.checkpoint;
    blocked.apply(f);
    assert.equal(startCompaction(f.pi, f.ctx, f.runtime, f.retryConfig), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls, { compact: 1, send: 0, abort: 0 });
    assert.equal(f.runtime.phase, "failed");
    assert.equal(f.runtime.checkpoint, checkpoint);
    assert.doesNotMatch(f.runtime.lastError, /PRIVATE CONTENT/);
    assert.equal(f.entries.some((entry) => ["completed", "resumed"].includes(entry.data.status)), false);
  });
}

test("eligible failed retry revalidates the current snapshot and complete persisted sibling batch", () => {
  const f = failedFixture();
  const snapshot = { compaction: { modelOverrides: { "test/new-model": { keepRecentTokens: 4321 } } } };
  f.pi.getSettings = () => snapshot;
  f.ctx.model = { provider: "test", id: "new-model" };
  let inspected = 0;
  f.ctx.sdkReadiness = function (settings) {
    inspected += 1;
    assert.equal(settings, snapshot);
    assert.equal(this.model.id, "new-model");
    return { ok: true, eligible: true, sessionId: "session-1", leafId: "leaf-1" };
  };
  f.contextEntries[0].message.content.push(...assistant("sibling").content);
  f.contextEntries.push({ type: "message", message: result("sibling") });
  assert.equal(startCompaction(f.pi, f.ctx, f.runtime, f.retryConfig), true);
  assert.equal(inspected, 1);
  assert.deepEqual(f.calls, { compact: 2, send: 0, abort: 0 });
  assert.equal(f.runtime.phase, "compacting");
});

test("initial start rechecks the latest settings/model without token heuristics or an idle requirement", () => {
  const f = fixture({ idle: false });
  const runtime = createRuntimeState();
  const seen = [];
  let snapshot = { compaction: { keepRecentTokens: 20_000 } };
  f.pi.getSettings = () => snapshot;
  f.ctx.model = { provider: "test", id: "model-A" };
  f.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 350_000, percent: 0 });
  f.ctx.isIdle = () => assert.fail("initial boundary must not require idle");
  f.ctx.sdkReadiness = function (settings) {
    seen.push({ settings, model: this.model });
    return { ok: true, eligible: true, sessionId: "session-1", leafId: "leaf-1" };
  };
  assert.equal(scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input).ok, true);
  assert.equal(seen[0].settings, snapshot);
  assert.equal(seen[0].model, f.ctx.model);
  snapshot = { compaction: { modelOverrides: { "test/model-B": { keepRecentTokens: 1234 } } } };
  f.ctx.model = { provider: "test", id: "model-B" };
  assert.equal(startCompaction(f.pi, f.ctx, runtime, config), true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].settings, snapshot);
  assert.equal(seen[1].model, f.ctx.model);
  assert.equal(f.calls.compact, 1);
});
