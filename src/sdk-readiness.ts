import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CompactionReadiness =
  | { ok: true; eligible: boolean; reason?: string; sessionId: string; leafId: string | null }
  | { ok: false; reason: string };
export type CompactionReadinessReader = (ctx: ExtensionContext, settings: unknown) => CompactionReadiness;
export type PublicReadinessAccessor = (input: {
  sessionManager: ExtensionContext["sessionManager"];
  model: ExtensionContext["model"];
  settings: unknown;
}) => CompactionReadiness;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Public SDK capability only; no package paths, private exports or module identity tests. */
export function createCompactionReadinessReader(
  accessor = (sdk as unknown as { readCompactionReadiness?: PublicReadinessAccessor }).readCompactionReadiness,
): CompactionReadinessReader {
  return (ctx, settings) => {
    try {
      // Access the public guarded value; do not depend on its descriptor/prototype.
      void ctx.cwd;
      if (!record(settings) || ![Object.prototype, null].includes(Object.getPrototypeOf(settings))) {
        return { ok: false, reason: "settings-invalid" };
      }
      if (typeof accessor !== "function") return { ok: false, reason: "sdk-readiness-unavailable" };
      const manager = ctx.sessionManager;
      const model = ctx.model;
      if (!model) return { ok: false, reason: "model-unavailable" };
      const sessionId = manager.getSessionId();
      const leafId = manager.getLeafId();
      if (!nonempty(sessionId) || !(leafId === null || nonempty(leafId))) return { ok: false, reason: "session-identity-invalid" };
      const identity = [model.provider, model.api, model.id];
      const result = accessor({ sessionManager: manager, model, settings });
      void ctx.cwd;
      const currentModel = ctx.model;
      if (ctx.sessionManager !== manager || manager.getSessionId() !== sessionId || manager.getLeafId() !== leafId ||
          !currentModel || [currentModel.provider, currentModel.api, currentModel.id].some((value, index) => value !== identity[index])) {
        return { ok: false, reason: "context-changed" };
      }
      if (!record(result) || typeof result.ok !== "boolean") return { ok: false, reason: "sdk-readiness-invalid-result" };
      if (!result.ok) {
        return { ok: false, reason: typeof result.reason === "string" && /^[a-z0-9-]{1,100}$/.test(result.reason)
          ? result.reason : "sdk-readiness-failed" };
      }
      if (typeof result.eligible !== "boolean" || result.sessionId !== sessionId || result.leafId !== leafId ||
          (result.reason !== undefined && (typeof result.reason !== "string" || !/^[a-z0-9-]{1,100}$/.test(result.reason)))) {
        return { ok: false, reason: "sdk-readiness-invalid-result" };
      }
      return { ok: true, eligible: result.eligible, sessionId, leafId,
        ...(result.reason === undefined ? {} : { reason: result.reason }) };
    } catch {
      return { ok: false, reason: "readiness-failed" };
    }
  };
}

/** Read-only readiness; this function never grants scheduler admission or calls a provider. */
export function readCompactionReadiness(ctx: ExtensionContext, settings: unknown): CompactionReadiness {
  return createCompactionReadinessReader()(ctx, settings);
}
