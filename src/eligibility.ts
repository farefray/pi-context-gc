import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCompactionReadiness, type CompactionReadinessReader } from "./sdk-readiness.ts";

type Eligibility = { ok: true; sessionId: string } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check the current snapshot and exact SDK boundary. The optional reader is a test seam. */
export function checkCompactionEligibility(pi: ExtensionAPI, ctx: ExtensionContext, readReadiness: CompactionReadinessReader = readCompactionReadiness): Eligibility {
  try {
    if (!("getSettings" in pi) || typeof pi.getSettings !== "function") {
      return { ok: false, reason: "public settings snapshot is unavailable" };
    }
    const settings: unknown = pi.getSettings();
    if (!isRecord(settings) || (Object.getPrototypeOf(settings) !== Object.prototype && Object.getPrototypeOf(settings) !== null)) {
      return { ok: false, reason: "public settings snapshot is malformed" };
    }
    const result: unknown = readReadiness(ctx, settings);
    if (!isRecord(result)) return { ok: false, reason: "SDK compaction readiness returned a malformed result" };
    if (result.ok === false && typeof result.reason === "string" && result.reason.length > 0) {
      return { ok: false, reason: "SDK compaction readiness could not establish eligibility" };
    }
    if (
      result.ok !== true ||
      typeof result.eligible !== "boolean" ||
      typeof result.sessionId !== "string" || result.sessionId.length === 0 ||
      !(result.leafId === null || (typeof result.leafId === "string" && result.leafId.length > 0)) ||
      (result.reason !== undefined && typeof result.reason !== "string")
    ) {
      return { ok: false, reason: "SDK compaction readiness returned a malformed result" };
    }
    if (result.sessionId !== ctx.sessionManager.getSessionId() || result.leafId !== ctx.sessionManager.getLeafId()) {
      return { ok: false, reason: "SDK compaction readiness does not match the active session branch" };
    }
    if (!result.eligible) return { ok: false, reason: "SDK reports no eligible compaction boundary" };
    return { ok: true, sessionId: result.sessionId };
  } catch {
    return { ok: false, reason: "unable to inspect SDK compaction eligibility" };
  }
}
