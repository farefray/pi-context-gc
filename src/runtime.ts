import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildCompactionInstructions, buildResumeMessage } from "./instructions.ts";
import { checkCompactionEligibility } from "./eligibility.ts";
import { readCompactionReadiness, type CompactionReadinessReader } from "./sdk-readiness.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { getTrailingCompleteToolResultBatch } from "./tool-batches.ts";
import {
  CHECKPOINT_ENTRY_TYPE,
  EXTENSION_ID,
  RESUME_MESSAGE_TYPE,
  type ContextCheckpoint,
  type ContextGcConfig,
  type ContextGcInput,
  type RuntimeState,
} from "./types.ts";

export function createRuntimeState(): RuntimeState {
  return {
    phase: "idle",
    generation: 0,
    checkpoint: undefined,
    lastError: undefined,
    lastCompletedCheckpointId: undefined,
    pendingPauseDiagnostic: undefined,
  };
}

export function resetRuntime(runtime: RuntimeState): void {
  runtime.generation += 1;
  runtime.phase = "idle";
  runtime.checkpoint = undefined;
  runtime.lastError = undefined;
  runtime.lastCompletedCheckpointId = undefined;
  runtime.pendingPauseDiagnostic = undefined;
}

export function invalidateRuntime(runtime: RuntimeState): void {
  resetRuntime(runtime);
}

export function safeSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return undefined;
  }
}

function sameSession(ctx: ExtensionContext, sessionId: string): boolean {
  return safeSessionId(ctx) === sessionId;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(
  ctx: ExtensionContext,
  config: ContextGcConfig,
  message: string,
  type: "info" | "warning" | "error",
  force = false,
): void {
  if (!ctx.hasUI || (!config.notify && !force)) return;
  try {
    ctx.ui.notify(`${EXTENSION_ID}: ${message}`, type);
  } catch {
    // UI is best-effort and must not affect context control flow.
  }
}

function setStatus(
  ctx: ExtensionContext,
  config: ContextGcConfig,
  text: string | undefined,
): void {
  if (!ctx.hasUI || !config.notify) return;
  try {
    ctx.ui.setStatus(EXTENSION_ID, text);
  } catch {
    // Best-effort only.
  }
}

function appendCheckpointEntry(
  pi: ExtensionAPI,
  checkpoint: ContextCheckpoint,
  status:
    | "requested"
    | "completed"
    | "failed"
    | "cancelled"
    | "resumed"
    | "continued-by-existing-turn",
  extra: Record<string, unknown> = {},
): void {
  try {
    pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
      version: 1,
      status,
      checkpoint,
      timestamp: Date.now(),
      ...extra,
    });
  } catch {
    // Persistence is diagnostic; the session compaction path remains authoritative.
  }
}

/** Read the SDK estimate once; invalid or unavailable token counts are unknown. */
export function readContextUsage(ctx: ExtensionContext): ReturnType<ExtensionContext["getContextUsage"]> {
  try {
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;
    const tokens = usage.tokens;
    return {
      ...usage,
      tokens: typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null,
    };
  } catch {
    return undefined;
  }
}

function minimumRefusal(
  config: ContextGcConfig,
  usage: ReturnType<typeof readContextUsage>,
): string | undefined {
  if (!(config.minContextTokens > 0)) return undefined;
  const tokens = usage?.tokens;
  if (tokens !== undefined && tokens !== null && tokens >= config.minContextTokens) return undefined;
  return `semantic GC requires at least ${config.minContextTokens} context tokens; current SDK usage: ${tokens ?? "unknown"}`;
}

export function scheduleCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  toolCallId: string,
  input: ContextGcInput,
  config: ContextGcConfig = DEFAULT_CONFIG,
  readReadiness: CompactionReadinessReader = readCompactionReadiness,
): { ok: true; checkpoint: ContextCheckpoint } | { ok: false; reason: string } {
  if (runtime.phase !== "idle") {
    return { ok: false, reason: `context GC is already ${runtime.phase}` };
  }

  const usage = readContextUsage(ctx);
  const refusal = minimumRefusal(config, usage);
  if (refusal) return { ok: false, reason: refusal };

  const eligibility = checkCompactionEligibility(pi, ctx, readReadiness);
  if (!eligibility.ok) return eligibility;
  const sessionId = eligibility.sessionId;

  const checkpoint: ContextCheckpoint = {
    id: randomUUID(),
    sessionId,
    toolCallId,
    requestedAt: Date.now(),
    input,
    ...(usage?.tokens !== null && usage?.tokens !== undefined
      ? { tokensAtRequest: usage.tokens }
      : {}),
    ...(usage ? { contextWindow: usage.contextWindow } : {}),
  };

  runtime.phase = "pending";
  runtime.checkpoint = checkpoint;
  runtime.lastError = undefined;
  appendCheckpointEntry(pi, checkpoint, "requested");
  return { ok: true, checkpoint };
}

function settleFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  checkpoint: ContextCheckpoint,
  message: string,
): void {
  runtime.phase = "failed";
  runtime.lastError = message;
  setStatus(ctx, config, "failed");
  appendCheckpointEntry(pi, checkpoint, "failed", { error: message });
  notify(
    ctx,
    config,
    `compaction failed: ${message}. The interrupted run was not resumed. Use /context-gc retry or /context-gc resume.`,
    "error",
    true,
  );

  if (config.resumeOnFailure) {
    const generation = runtime.generation;
    setImmediate(() => {
      if (runtime.generation !== generation || runtime.phase !== "failed" || runtime.checkpoint?.id !== checkpoint.id) return;
      resumeCheckpoint(pi, ctx, runtime, config, "automatic failure fallback");
    });
  }
}

function dispatchCheckpointResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  checkpoint: ContextCheckpoint,
  reason: string,
): boolean {
  if (!sameSession(ctx, checkpoint.sessionId)) return false;

  try {
    pi.sendMessage(
      {
        customType: RESUME_MESSAGE_TYPE,
        content: [
          buildResumeMessage(checkpoint, runtime.lastCompletedCheckpointId === checkpoint.id),
          "",
          `Continuation reason: ${reason}`,
        ].join("\n"),
        display: false,
        details: {
          checkpointId: checkpoint.id,
          nextFocus: checkpoint.input.next_focus,
          reason,
        },
      },
      { triggerTurn: true },
    );
  } catch (error) {
    runtime.phase = "failed";
    runtime.checkpoint = checkpoint;
    runtime.lastError = `unable to dispatch continuation: ${errorText(error)}`;
    setStatus(ctx, config, "failed");
    notify(ctx, config, runtime.lastError, "error", true);
    return false;
  }

  appendCheckpointEntry(pi, checkpoint, "resumed", { reason });
  runtime.pendingPauseDiagnostic = undefined;
  runtime.generation += 1;
  runtime.phase = "idle";
  runtime.checkpoint = undefined;
  runtime.lastError = undefined;
  setStatus(ctx, config, undefined);
  return true;
}

function finishAndMaybeResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  checkpoint: ContextCheckpoint,
  generation: number,
): void {
  if (
    runtime.generation !== generation ||
    runtime.phase !== "resume-pending" ||
    runtime.checkpoint?.id !== checkpoint.id ||
    !sameSession(ctx, checkpoint.sessionId)
  ) {
    return;
  }

  let idle = false;
  try {
    idle = ctx.isIdle();
  } catch (error) {
    settleFailure(pi, ctx, runtime, config, checkpoint, `unable to inspect continuation state: ${errorText(error)}`);
    return;
  }

  if (!config.autoResume) {
    // Keep the checkpoint live so `/context-gc resume` can materialize it later.
    setStatus(ctx, config, "resume pending");
    notify(
      ctx,
      config,
      "compaction completed; automatic resume is disabled. Use /context-gc resume when ready.",
      "info",
    );
    return;
  }

  let hasPendingMessages = false;
  try {
    hasPendingMessages = ctx.hasPendingMessages();
  } catch (error) {
    settleFailure(pi, ctx, runtime, config, checkpoint, `unable to inspect continuation queue: ${errorText(error)}`);
    return;
  }

  if (!idle || hasPendingMessages) {
    appendCheckpointEntry(pi, checkpoint, "continued-by-existing-turn", {
      idle,
      hasPendingMessages,
    });
    runtime.generation += 1;
    runtime.phase = "idle";
    runtime.checkpoint = undefined;
    runtime.lastError = undefined;
    setStatus(ctx, config, undefined);
    notify(
      ctx,
      config,
      "compaction completed; an existing queued turn already owns continuation.",
      "info",
    );
    return;
  }

  if (dispatchCheckpointResume(
    pi,
    ctx,
    runtime,
    config,
    checkpoint,
    "semantic phase-boundary compaction completed",
  )) {
    notify(ctx, config, "compaction completed; resumed from the task checkpoint.", "info");
  }
}

/** Persist only the current pause at a known idle boundary; never start work. */
export function flushPendingPauseDiagnostic(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
): void {
  const pending = runtime.pendingPauseDiagnostic;
  if (!pending) return;
  const checkpoint = runtime.checkpoint;
  if (
    runtime.generation !== pending.generation ||
    runtime.phase !== "failed" ||
    checkpoint?.id !== pending.checkpointId ||
    checkpoint.sessionId !== pending.sessionId ||
    !sameSession(ctx, pending.sessionId)
  ) {
    runtime.pendingPauseDiagnostic = undefined;
    return;
  }
  try {
    if (ctx.isIdle() !== true) return;
  } catch {
    // Unknown idle state cannot authorize a session mutation.
    return;
  }
  // Consume before the best-effort append, including when persistence throws.
  runtime.pendingPauseDiagnostic = undefined;
  appendCheckpointEntry(pi, checkpoint, "failed", { error: pending.error });
}

function pauseBeforeCompaction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  checkpoint: ContextCheckpoint,
  reason: string,
  idleRetry: boolean,
): false {
  // Admission/recheck refusals must never invoke the automatic failure fallback.
  runtime.generation += 1;
  runtime.phase = "failed";
  runtime.lastError = reason;
  runtime.pendingPauseDiagnostic = undefined;
  // The API may now belong to a replacement session. Keep the old failure in
  // memory only; never append its checkpoint ledger or UI state to the new one.
  if (!sameSession(ctx, checkpoint.sessionId)) return false;
  setStatus(ctx, config, "paused");
  runtime.pendingPauseDiagnostic = {
    generation: runtime.generation,
    checkpointId: checkpoint.id,
    sessionId: checkpoint.sessionId,
    error: reason,
  };
  // A context transform must not change the request's leaf, even if an idle
  // getter says true. Only a manual retry may persist here after an idle check.
  if (idleRetry) flushPendingPauseDiagnostic(pi, ctx, runtime);
  notify(ctx, config, `compaction paused: ${reason}. No compaction or automatic continuation was started. Follow the current user instructions, or inspect /context-gc status.`, "warning", true);
  return false;
}

function persistedTrailingBatch(ctx: ExtensionContext) {
  try {
    const messages = ctx.sessionManager.buildContextEntries()
      .flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    return getTrailingCompleteToolResultBatch(messages);
  } catch {
    return undefined;
  }
}

/**
 * Start one Pi-owned compaction. Pi aborts the active low-level run, then enters
 * its standard manual compaction pipeline. Any installed session_before_compact
 * backend therefore handles both this request and Pi's normal safety triggers.
 */
export function startCompaction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  readReadiness: CompactionReadinessReader = readCompactionReadiness,
): boolean {
  const checkpoint = runtime.checkpoint;
  if (!checkpoint) return false;
  if (runtime.phase !== "pending" && runtime.phase !== "failed") return false;
  const retry = runtime.phase === "failed";
  const pause = (reason: string): false =>
    pauseBeforeCompaction(pi, ctx, runtime, config, checkpoint, reason, retry);
  if (!sameSession(ctx, checkpoint.sessionId)) {
    return pause("active session changed before compaction");
  }
  try {
    if (ctx.signal?.aborted || ctx.hasPendingMessages() !== false) {
      return pause("Stop or queued input owns continuation");
    }
    // Initial context boundaries belong to an active turn; only recovery needs idle.
    if (retry && ctx.isIdle() !== true) {
      return pause("retry requires an idle agent");
    }
  } catch {
    return pause("unable to inspect active operation or input queue");
  }
  if (retry && !persistedTrailingBatch(ctx)?.toolCallIds.has(checkpoint.toolCallId)) {
    return pause("retry requires the complete persisted trailing checkpoint tool batch");
  }

  const generation = runtime.generation + 1;
  const customInstructions = buildCompactionInstructions(checkpoint);
  let callbackSettled = false;
  const claim = (): boolean => {
    if (callbackSettled) return false;
    callbackSettled = true;
    return (
      runtime.generation === generation &&
      runtime.phase === "compacting" &&
      runtime.checkpoint?.id === checkpoint.id &&
      sameSession(ctx, checkpoint.sessionId)
    );
  };

  // Never reuse tokensAtRequest: context can change after tool acceptance or failure.
  if (config.minContextTokens > 0) {
    const refusal = minimumRefusal(config, readContextUsage(ctx));
    if (refusal) return pause(refusal);
  }

  // Read the current model, branch and public settings synchronously.
  // Recheck on every attempt, including retry, before Pi can abort the active run.
  const eligibility = checkCompactionEligibility(pi, ctx, readReadiness);
  if (!eligibility.ok) {
    return pause(eligibility.reason);
  }
  if (eligibility.sessionId !== checkpoint.sessionId) {
    return pause("active session changed before compaction");
  }
  runtime.pendingPauseDiagnostic = undefined;
  runtime.phase = "compacting";
  runtime.generation = generation;
  runtime.lastError = undefined;
  try {
    ctx.compact({
      customInstructions,
      onComplete: (result) => {
        if (!claim()) return;
        runtime.phase = "resume-pending";
        runtime.lastCompletedCheckpointId = checkpoint.id;
        runtime.lastError = undefined;
        setStatus(ctx, config, "resume pending");
        appendCheckpointEntry(pi, checkpoint, "completed", {
          result: {
            tokensBefore: result.tokensBefore,
            estimatedTokensAfter: result.estimatedTokensAfter,
          },
        });

        // Pi flushes queued input from its compaction-end handler. Defer one
        // event-loop turn so ctx.isIdle() reflects any turn already started.
        setImmediate(() => finishAndMaybeResume(pi, ctx, runtime, config, checkpoint, generation));
      },
      onError: (error) => {
        if (!claim()) return;
        settleFailure(pi, ctx, runtime, config, checkpoint, errorText(error));
      },
    });
  } catch (error) {
    if (!callbackSettled) callbackSettled = true;
    if (runtime.generation === generation && sameSession(ctx, checkpoint.sessionId)) {
      settleFailure(pi, ctx, runtime, config, checkpoint, errorText(error));
    }
    return false;
  }

  if (runtime.phase === "compacting") {
    setStatus(ctx, config, "compacting");
    notify(ctx, config, "semantic checkpoint accepted; starting Pi compaction.", "info");
  }
  return true;
}

/** Trigger only when the checkpoint tool result belongs to a complete trailing batch. */
export function maybeStartAtContextBoundary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  messages: readonly unknown[],
  readReadiness: CompactionReadinessReader = readCompactionReadiness,
): boolean {
  if (!config.enabled || runtime.phase !== "pending" || !runtime.checkpoint) return false;
  const toolCallId = runtime.checkpoint.toolCallId;
  const batch = getTrailingCompleteToolResultBatch(messages);
  if (!batch || !batch.toolCallIds.has(toolCallId)) return false;

  // Context handlers may transform messages; only persisted history proves the
  // tool and every sibling result have actually finished and been recorded.
  const persistedBatch = persistedTrailingBatch(ctx);
  if (!persistedBatch || !persistedBatch.toolCallIds.has(toolCallId)) return false;
  if (persistedBatch.toolCallIds.size !== batch.toolCallIds.size) return false;
  for (const id of batch.toolCallIds) {
    if (!persistedBatch.toolCallIds.has(id)) return false;
  }

  return startCompaction(pi, ctx, runtime, config, readReadiness);
}

export function cancelPending(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  reason: string,
): boolean {
  const checkpoint = runtime.checkpoint;
  if (!checkpoint || !["pending", "failed", "resume-pending"].includes(runtime.phase)) return false;
  appendCheckpointEntry(pi, checkpoint, "cancelled", { reason });
  runtime.pendingPauseDiagnostic = undefined;
  runtime.generation += 1;
  runtime.phase = "idle";
  runtime.checkpoint = undefined;
  runtime.lastError = undefined;
  setStatus(ctx, config, undefined);
  notify(ctx, config, `checkpoint cancelled: ${reason}`, "warning");
  return true;
}

export function resumeCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: RuntimeState,
  config: ContextGcConfig,
  reason: string,
): boolean {
  const checkpoint = runtime.checkpoint;
  if (!checkpoint || !["pending", "failed", "resume-pending"].includes(runtime.phase)) return false;
  if (!sameSession(ctx, checkpoint.sessionId)) return false;
  try {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return false;
  } catch {
    // A recovery command/fallback must not race an uninspectable active turn.
    return false;
  }

  return dispatchCheckpointResume(pi, ctx, runtime, config, checkpoint, reason);
}

/** @deprecated Use resumeCheckpoint; retained for API compatibility with early builds. */
export const resumeWithoutCompaction = resumeCheckpoint;

export function formatRuntimeStatus(runtime: RuntimeState, config: ContextGcConfig): string {
  const lines = [
    `phase: ${runtime.phase}`,
    `enabled: ${config.enabled}`,
    `minimum context tokens: ${config.minContextTokens}`,
    `auto resume: ${config.autoResume}`,
    `resume on failure: ${config.resumeOnFailure}`,
  ];
  if (runtime.checkpoint) {
    lines.push(`checkpoint: ${runtime.checkpoint.id}`);
    lines.push(`completed phase: ${runtime.checkpoint.input.completed_phase}`);
    lines.push(`next focus: ${runtime.checkpoint.input.next_focus}`);
    if (runtime.checkpoint.tokensAtRequest !== undefined) {
      lines.push(`tokens at request: ${runtime.checkpoint.tokensAtRequest.toLocaleString()}`);
    }
  }
  if (runtime.lastError) lines.push(`last error: ${runtime.lastError}`);
  if (runtime.lastCompletedCheckpointId) {
    lines.push(`last completed checkpoint: ${runtime.lastCompletedCheckpointId}`);
  }
  return lines.join("\n");
}
