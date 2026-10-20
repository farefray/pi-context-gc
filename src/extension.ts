import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadConfig } from "./config.ts";
import { readCompactionReadiness, type CompactionReadinessReader } from "./sdk-readiness.ts";
import {
  cancelPending,
  createRuntimeState,
  formatRuntimeStatus,
  flushPendingPauseDiagnostic,
  invalidateRuntime,
  maybeStartAtContextBoundary,
  resetRuntime,
  resumeCheckpoint,
  scheduleCheckpoint,
  startCompaction,
} from "./runtime.ts";
import {
  COMMAND_NAME,
  EXTENSION_ID,
  TOOL_NAME,
  type LoadedConfig,
} from "./types.ts";

// Project admission consumers must use the same effective config reader.
export { loadConfig };

const CompactContextParameters = Type.Object(
  {
    completed_phase: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: "The coherent phase that is now complete, including its outcome.",
    }),
    next_focus: Type.String({
      minLength: 1,
      maxLength: 2000,
      description: "The exact next subtask or working set to continue after compaction.",
    }),
    keep: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 16,
      description: "Durable decisions, invariants, changed files, identifiers, constraints, and facts the next phase needs.",
    }),
    open_loops: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 12 }),
    ),
    ruled_out: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        maxItems: 12,
        description: "Investigated paths that should not be repeated without new evidence.",
      }),
    ),
    verification: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
      maxItems: 12,
      description: "Concrete evidence that the completed phase is done: tests, checks, acceptance criteria, or validated conclusions. Put remaining failures in open_loops.",
    }),
  },
  { additionalProperties: false },
);

type CompactContextInput = Static<typeof CompactContextParameters>;

interface ContextGcToolDetails {
  accepted: boolean;
  reason?: string;
  checkpointId?: string;
  tokensAtRequest?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notifyDiagnostics(ctx: ExtensionContext, loaded: LoadedConfig): void {
  if (!ctx.hasUI) return;
  for (const warning of loaded.warnings) {
    ctx.ui.notify(`${EXTENSION_ID}: ${warning}`, "warning");
  }
}

/** Optional, activation-local admission. Neither callback grants host eligibility. */
export interface ContextGcAdmissionOptions {
  admitSession: (event: SessionStartEvent, ctx: ExtensionContext) => boolean;
  isActive: (ctx: ExtensionContext) => boolean;
}

function registerCommand(
  pi: ExtensionAPI,
  runtime: ReturnType<typeof createRuntimeState>,
  getLoaded: (ctx: ExtensionContext) => LoadedConfig,
  isActive: (ctx: ExtensionContext) => boolean,
  runtimeContext: (ctx: ExtensionContext) => ExtensionContext,
  readReadiness: CompactionReadinessReader,
): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Inspect or recover semantic context GC (status | retry | resume | cancel)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!isActive(ctx)) {
        if (ctx.hasUI) ctx.ui.notify(`${EXTENSION_ID}: inactive in the current session context.`, "info");
        return;
      }
      const loaded = getLoaded(ctx);
      const activeContext = runtimeContext(ctx);
      const action = args.trim().toLowerCase() || "status";

      if (action === "status") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            [
              formatRuntimeStatus(runtime, loaded.config),
              `global config: ${loaded.globalPath}`,
              `project config: ${loaded.projectPath}`,
              `loaded config: ${loaded.loadedSources.join(", ") || "none"}`,
            ].join("\n"),
            "info",
          );
        }
        return;
      }

      if (action === "retry") {
        if (runtime.phase !== "failed" || !runtime.checkpoint) {
          if (ctx.hasUI) ctx.ui.notify(`${EXTENSION_ID}: there is no failed checkpoint to retry.`, "warning");
          return;
        }
        startCompaction(pi, activeContext, runtime, loaded.config, readReadiness);
        return;
      }

      if (action === "resume") {
        if (!resumeCheckpoint(pi, activeContext, runtime, loaded.config, "user requested /context-gc resume")) {
          if (ctx.hasUI) ctx.ui.notify(`${EXTENSION_ID}: resume requires a checkpoint in the same session, an idle agent, and no queued messages; state inspection must succeed.`, "warning");
        }
        return;
      }

      if (action === "cancel") {
        if (!cancelPending(pi, activeContext, runtime, loaded.config, "user requested /context-gc cancel")) {
          if (ctx.hasUI) ctx.ui.notify(`${EXTENSION_ID}: there is no pending or failed checkpoint.`, "warning");
        }
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(`${EXTENSION_ID}: usage: /context-gc status | retry | resume | cancel`, "warning");
      }
    },
  });
}

/** The optional reader argument is an explicit deterministic-test seam, not a host hook. */
export function createContextGcExtension(options?: ContextGcAdmissionOptions, readReadiness: CompactionReadinessReader = readCompactionReadiness): (pi: ExtensionAPI) => void {
  return function contextGcExtension(pi: ExtensionAPI): void {
    const runtime = createRuntimeState();
    let loadedConfig: LoadedConfig | undefined;

    const getLoaded = (ctx: ExtensionContext): LoadedConfig => {
      loadedConfig ??= loadConfig(ctx);
      return loadedConfig;
    };

    let admitted = options === undefined;
    let exposure: "hidden" | "model-only" = admitted ? "model-only" : "hidden";
    const setExposure = (next: typeof exposure): void => {
      if (exposure === next) return;
      const exposedTool: typeof compactContextTool = { ...compactContextTool, exposure: next };
      pi.registerTool(exposedTool);
      exposure = next;
    };
    const isActive = (ctx: ExtensionContext): boolean => {
      if (!options) return true;
      let active = false;
      try {
        active = admitted && options.isActive(ctx) === true;
      } catch {
        // Admission errors must not leak session content or enable work.
      }
      if (!active) invalidateRuntime(runtime);
      setExposure(active ? "model-only" : "hidden");
      return active;
    };

    // Runtime callbacks and deferred resumes already check session identity.
    // Recheck admission at that same boundary, including when no event ran
    // between compaction completion and the deferred continuation. Proxy only
    // the identity read, preserving non-enumerable host fields and SDK getters.
    const runtimeContext = (ctx: ExtensionContext): ExtensionContext => {
      if (!options) return ctx;
      const manager = new Proxy(ctx.sessionManager, {
        get(target, property) {
          if (property === "getSessionId") return () => {
            if (!isActive(ctx)) throw new Error("Context GC is inactive.");
            return target.getSessionId();
          };
          return Reflect.get(target, property, target);
        },
      });
      return new Proxy(ctx, {
        get(target, property) {
          return property === "sessionManager" ? manager : Reflect.get(target, property, target);
        },
      });
    };

    pi.on("session_start", (event, ctx) => {
      admitted = options === undefined;
      if (options) {
        setExposure("hidden");
        try {
          admitted = options.admitSession(event, ctx) === true;
        } catch {
          // A failed admission (including persistence) stays hidden.
        }
      }
      resetRuntime(runtime);
      loadedConfig = undefined;
      if (!isActive(ctx)) return;
      loadedConfig = loadConfig(ctx);
      notifyDiagnostics(ctx, loadedConfig);
    });

    pi.on("before_agent_start", (event, ctx) => {
      if (!isActive(ctx)) return;
      const { config } = getLoaded(ctx);
      if (!config.enabled || config.minContextTokens === 0) return;
      // Keep this advisory independent of usage: another extension may render
      // these sections into the leading prompt, invalidating its cached prefix.
      const policyBody = [
        `Semantic GC minimum: ${config.minContextTokens} context tokens.`,
        "The minimum does not establish readiness. The scheduler checks current SDK usage and exact SDK eligibility before acceptance and again before compaction or retry.",
        "Use compact_context only at a completed phase boundary with a materially different next working set, after the minimum and exact eligibility are satisfied, never just before the final answer.",
        "If usage is unknown or below the minimum, continue current work. Do not prepare a checkpoint or call compact_context merely to discover the minimum; do not make repeated probe calls.",
        "This policy does not change Pi's regular automatic/overflow compaction or manual /compact.",
      ].join("\n");
      // SDK 1.3 normalizes sections before this hook. Returning systemPrompt
      // would force a whole-prompt replacement and hide later section updates.
      // Keep the inherited structural path; only exact SDK1.3 readiness is qualified.
      const promptOptions: unknown = event.systemPromptOptions;
      if (isRecord(promptOptions) && "sections" in promptOptions) {
        if (isRecord(promptOptions.sections)) {
          promptOptions.sections["pi-context-gc-policy"] = policyBody;
        }
        return;
      }

      // Preserve the inherited string-policy fallback for section-less events.
      // This does not establish readiness or qualify older SDK versions.
      const policyText = `\n\n<pi-context-gc-policy>\n${policyBody}\n</pi-context-gc-policy>`;
      // Usually Pi supplies the unmodified prompt on each run. If our previous
      // block is supplied again, refresh only that block, retaining foreign text.
      const systemPrompt = event.systemPrompt.replace(/\n\n<pi-context-gc-policy>\n[\s\S]*?\n<\/pi-context-gc-policy>/g, "");
      return { systemPrompt: systemPrompt + policyText };
    });

    // Preserve dynamic model-only/hidden exposure across optional admission.
    const compactContextTool: ToolDefinition<typeof CompactContextParameters, ContextGcToolDetails> & {
      exposure: "model-only" | "hidden";
    } = {
      name: TOOL_NAME,
      label: "Compact Context",
      description:
        "Request semantic context garbage collection at a real phase boundary. Use only after a coherent phase is complete and the next phase no longer needs its raw reads, logs, test output, or superseded snapshots. This tool records a task/search checkpoint; the harness waits for the entire tool-result batch, runs Pi's standard compaction pipeline, and resumes automatically. Do not call merely because context is large, while hypotheses are unresolved, or immediately before the final answer. Call it alone when possible.",
      promptSnippet: "Checkpoint completed task state and compact obsolete context before a substantially different phase",
      promptGuidelines: [
        "Use compact_context only after the configured semantic GC minimum and exact SDK eligibility are satisfied, a coherent phase is complete, and the next phase has a materially different working set.",
        "When a positive minimum applies and SDK usage is unknown or below it, continue current work without preparing a checkpoint or probing compact_context to discover the minimum; do not make repeated probe calls.",
        "Call compact_context only when completed_phase, next_focus, durable state, open loops, ruled-out paths, and verification status can be stated accurately.",
        "Do not use compact_context as a generic progress update, while debugging unresolved competing hypotheses, alongside avoidable sibling tools, or just before returning the final answer.",
        "Only when compact_context returns accepted:true, stop issuing further work in that turn; the harness will recheck eligibility after the complete persisted tool batch and resume after successful compaction. If not accepted, continue current work without stopping the phase.",
      ],
      parameters: CompactContextParameters,
      executionMode: "sequential",
      exposure,
      async execute(
        toolCallId,
        params: CompactContextInput,
        signal,
        _onUpdate,
        ctx,
      ): Promise<AgentToolResult<ContextGcToolDetails>> {
        if (!isActive(ctx)) {
          return {
            content: [{ type: "text", text: "Context GC is inactive. Continue current work; do not stop this phase." }],
            details: { accepted: false, reason: "inactive" },
          };
        }
        const loaded = getLoaded(ctx);
        if (!loaded.config.enabled) {
          return {
            content: [{ type: "text", text: "Context GC is disabled by configuration. Continue current work; do not stop this phase." }],
            details: { accepted: false, reason: "disabled" },
          };
        }
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Context GC request was aborted. Continue current work only if the active user instructions permit it; do not stop this phase for compaction." }],
            details: { accepted: false, reason: "aborted" },
          };
        }

        const result = scheduleCheckpoint(pi, runtimeContext(ctx), runtime, toolCallId, params, loaded.config, readReadiness);
        if (!result.ok) {
          return {
            content: [{ type: "text", text: `Context GC was not scheduled: ${result.reason}. Continue current work; do not stop this phase.` }],
            details: { accepted: false, reason: result.reason },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: "Semantic checkpoint recorded. Stop this phase now. The harness will recheck eligibility and compact only after this complete tool-result batch is persisted, then resume from next_focus after successful compaction.",
            },
          ],
          details: {
            accepted: true,
            checkpointId: result.checkpoint.id,
            ...(result.checkpoint.tokensAtRequest !== undefined
              ? { tokensAtRequest: result.checkpoint.tokensAtRequest }
              : {}),
          },
        };
      },
    };
    pi.registerTool(compactContextTool);

    pi.on("context", (event, ctx) => {
      if (!isActive(ctx)) return;
      const loaded = getLoaded(ctx);
      maybeStartAtContextBoundary(pi, runtimeContext(ctx), runtime, loaded.config, event.messages, readReadiness);
    });

    pi.on("model_select", (_event, ctx) => {
      if (!options) return;
      invalidateRuntime(runtime);
      isActive(ctx);
    });

    // SDK 1.3 settlement starts no work, including after Stop. Persist a paused
    // diagnostic only at known idle; pending compaction still needs a context boundary.
    pi.on("agent_settled", (_event, ctx) => {
      if (!isActive(ctx)) return;
      flushPendingPauseDiagnostic(pi, runtimeContext(ctx), runtime);
      const loaded = getLoaded(ctx);
      if (runtime.phase !== "pending" || !ctx.hasUI || !loaded.config.notify) return;
      try {
        ctx.ui.notify(
          `${EXTENSION_ID}: checkpoint remains pending; compaction has not started. Use /context-gc status, resume, or cancel.`,
          "info",
        );
      } catch {
        // Notification must not affect scheduler state.
      }
    });

    // A real user steer changes the dependency graph. Do not compact against a
    // checkpoint produced before that instruction.
    pi.on("input", (event, ctx) => {
      if (!isActive(ctx)) return;
      if (runtime.phase !== "pending" || event.source === "extension") return;
      const loaded = getLoaded(ctx);
      cancelPending(pi, runtimeContext(ctx), runtime, loaded.config, "new user input arrived before compaction");
    });

    // Navigation invalidates in-memory checkpoints and callbacks, even when
    // another extension later cancels the requested tree transition.
    pi.on("session_before_tree", () => {
      invalidateRuntime(runtime);
      if (options) setExposure("hidden");
    });
    pi.on("session_tree", (_event, ctx) => {
      invalidateRuntime(runtime);
      if (options) isActive(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      invalidateRuntime(runtime);
      if (options) {
        admitted = false;
        setExposure("hidden");
      }
      if (ctx.hasUI) {
        try {
          ctx.ui.setStatus(EXTENSION_ID, undefined);
        } catch {
          // Best-effort cleanup.
        }
      }
    });

    registerCommand(pi, runtime, getLoaded, isActive, runtimeContext, readReadiness);
  };
}

export default createContextGcExtension();
