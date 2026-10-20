import test from "node:test";
import assert from "node:assert/strict";
import { buildCompactionInstructions, buildResumeMessage } from "../dist/src/instructions.js";

const checkpoint = {
  id: "cp",
  sessionId: "s",
  toolCallId: "t",
  requestedAt: 1,
  input: {
    completed_phase: "auth fixed",
    next_focus: "database migration",
    keep: ["API contract unchanged"],
    open_loops: ["rollback missing"],
    ruled_out: ["Redis expiry"],
    verification: ["auth suite passes"],
  },
};

test("guidance preserves task, search, and verification ledgers", () => {
  const text = buildCompactionInstructions(checkpoint);
  assert.match(text, /auth fixed/);
  assert.match(text, /database migration/);
  assert.match(text, /API contract unchanged/);
  assert.match(text, /Redis expiry/);
  assert.match(text, /auth suite passes/);
  assert.match(text, /Raw tool logs/);
  assert.match(text, /Do not reinterpret the task as complete/);
});

test("resume message is narrow and anchored on next focus", () => {
  const text = buildResumeMessage(checkpoint);
  assert.match(text, /database migration/);
  assert.match(text, /Do not redo prior exploration/);
  assert.match(text, /API contract unchanged/);
  assert.match(text, /Redis expiry/);
  assert.match(text, /auth suite passes/);
  assert.match(text, /auth fixed/);
  assert.match(text, /rollback missing/);
  assert.match(text, /No successful compaction has completed for this checkpoint/);
  assert.doesNotMatch(text, /The semantic phase-boundary compaction completed\./);
});

test("resume completion claim requires explicit successful checkpoint completion", () => {
  const text = buildResumeMessage(checkpoint, true);
  assert.match(text, /The semantic phase-boundary compaction completed\./);
  assert.doesNotMatch(text, /No successful compaction/);
  for (const value of [checkpoint.input.completed_phase, checkpoint.input.next_focus,
    ...checkpoint.input.keep, ...checkpoint.input.open_loops,
    ...checkpoint.input.ruled_out, ...checkpoint.input.verification]) {
    assert.ok(text.includes(value));
  }
});
